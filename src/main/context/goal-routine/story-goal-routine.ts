/**
 * 短故事目标循环运行器 —— loop-engineering 的 automations + 状态机。
 *
 * 状态机（每轮做一个阶段动作 + 末尾 goal check）：
 *   outline → 无节拍则生成节拍大纲
 *   draft   → 取下一个无正文节拍，generateBeatBody 写库
 *   check   → checkStoryGoal；met 则停；否则 fix
 *   fix     → 取最弱节拍重写 → check
 *
 * 安全 guardrail：轮次硬上限、AbortController 可取消、每轮写轮次记忆、
 * 重启不自动续跑（由 bootstrap reconcile running→paused）。
 */
import type { WebContents } from 'electron'
import { appLogger } from '../../logger/app-logger'
import { volumeChapterDAO, goalRoutineDAO } from '../../db'
import { modelService } from '../../model'
import { parseChapterSuggestions } from '../parse-chapters'
import { outlineConstraintsForWordTarget } from '../../../shared/outline-constraints'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../../shared/writing-plan-presets'
import { loadWritingPlan } from '../writing-plan'
import {
  checkStoryGoal,
  DEFAULT_STORY_GOAL_CONFIG,
  type StoryGoalConfig,
  type GoalCheckResult
} from './story-goal-checker'
import { generateBeatBody } from './story-goal-doer'

type Phase = 'outline' | 'draft' | 'check' | 'fix'

export interface GoalProgressEvent {
  workId: number
  turn: number
  maxTurns: number
  phase: Phase
  status: string
  check?: GoalCheckResult
  message: string
}

const activeLoops = new Map<number, AbortController>()

export function isGoalLoopRunning(workId: number): boolean {
  return activeLoops.has(workId)
}

export function cancelGoalLoop(workId: number): boolean {
  const controller = activeLoops.get(workId)
  if (!controller) return false
  controller.abort()
  return true
}

function safeSend(sender: WebContents | undefined, channel: string, payload: unknown): void {
  if (!sender || sender.isDestroyed()) return
  try {
    sender.send(channel, payload)
  } catch { /* 接收方已销毁 */ }
}

/** 构造短故事节拍拆解的 system prompt（复刻 ChaptersPanel 的 story 分支） */
function buildBeatBatchSystemPrompt(wordsPerChapter: number): string {
  const oc = outlineConstraintsForWordTarget(wordsPerChapter)
  return [
    '这是一篇一镜到底的短故事。请根据短故事的主线规划，将其拆解为连续的情节节拍（Beats），每个节拍负责推进一段核心剧情。',
    '【极度紧凑与高潮迭起约束 - 硬要求】',
    '短故事要求剧情极度紧凑，节奏极快。禁止安排任何平淡的"过渡节拍"或"日常水文"。',
    '每个节拍都必须有核心矛盾冲突或情绪爆发，爽点或反转必须一个接一个密集抛出。',
    '【输出格式 - 必须严格遵守】',
    '只输出一个 JSON 对象；禁止 Markdown 标题、前置说明、思考过程，以及 ``` 代码块围栏。',
    'chapters 数组每一项为一个节拍（请勿输出"第X章"或"节拍X"字样，直接写节拍剧情标题即可）。',
    `每章字段：title、plot_points（${oc.pointsMin}-${oc.pointsMax} 条情节节点数组）、beat_role、foreshadow_target、next_hook、characters（本章出场角色名数组）。`,
    'beat_role: A(爽点释放)/B(进行中)/C(铺垫)/transition(过渡)',
    `【长度】每项 plot_points 合计 ${oc.charsMin}-${oc.charsMax} 字梗概（每节拍目标 ${wordsPerChapter} 字正文），禁止正文级长文。`,
    `格式：{"chapters":[{"title":"节拍剧情标题","plot_points":["节点1","节点2","节点3"],"beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}]}`
  ].join('\n')
}

/** outline 阶段：若无节拍，生成节拍大纲并入库（注入创作目标） */
async function ensureBeats(
  workId: number,
  goalDescription: string,
  signal?: AbortSignal
): Promise<{ created: number; error?: string }> {
  const existing = volumeChapterDAO.listChaptersByWork(workId)
  if (existing.length > 0) return { created: 0 }

  const volumes = volumeChapterDAO.listVolumes(workId)
  const volumeId = volumes[0]?.id
  if (!volumeId) return { created: 0, error: '作品无分卷' }

  const plan = loadWritingPlan(workId)
  const wpc = plan.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER
  const suggestedCount = plan.targetTotalWords > 0
    ? Math.max(3, Math.ceil(plan.targetTotalWords / wpc))
    : 5

  const vol = volumes[0]
  const prompt = [
    `【短故事一镜到底】当前需要将其拆解为连续的情节节拍，共约 ${suggestedCount} 个节拍。`,
    goalDescription.trim() ? `【短故事创作目标】${goalDescription.trim()}，请据此拆解节拍（题材/风格/情节走向须贴合目标）` : '',
    vol.description ? `分卷说明：${vol.description}` : '',
    '请输出完整 chapters 数组。'
  ].filter(Boolean).join('\n')

  const response = await modelService.chat(
    {
      prompt,
      systemPrompt: buildBeatBatchSystemPrompt(wpc),
      step: 'volume_chapters_batch',
      workId,
      volumeId,
      workContextOptions: { includeVolumes: true }
    },
    { stream: false, signal }
  )

  if (!response.success || !response.content?.trim()) {
    return { created: 0, error: response.error || '节拍生成失败' }
  }

  const parsed = parseChapterSuggestions(response.content.trim())
  if (parsed.length === 0) return { created: 0, error: '节拍解析为空' }

  const items = parsed.map(p => ({
    title: p.title,
    outline: p.outline ?? '',
    beat_role: p.beat_role ?? null,
    foreshadow_target: p.foreshadow_target ?? null,
    next_hook: p.next_hook ?? null,
    characters: p.characters ?? null
  }))
  volumeChapterDAO.batchCreateChapters(volumeId, items, 'append')
  return { created: items.length }
}

/** draft 阶段：取下一个无正文节拍生成正文 */
function nextEmptyBeat(workId: number): { id: number; title: string } | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const empty = chapters.find(c => !c.content?.trim())
  return empty ? { id: empty.id, title: empty.title } : null
}

/** 取正文最短的节拍（字数不足/信息最弱时优先扩写重写） */
function shortestBeat(workId: number): { id: number; title: string } | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.content?.trim())
  if (chapters.length === 0) return null
  const shortest = chapters.reduce((a, b) =>
    (a.word_count || 0) < (b.word_count || 0) ? a : b
  )
  return { id: shortest.id, title: shortest.title }
}

/** 取 AI 特征最高的节拍（整文困惑度检测后，取最差段对应的节拍） */
function highestAiBeat(workId: number): { id: number; title: string } | null {
  // 无分段困惑度结果时退化为最短节拍
  return shortestBeat(workId)
}

/**
 * 运行短故事目标循环，直到目标达成或轮次上限。
 * 非阻塞：在后台异步跑，通过 sender 发 goal:progress 事件。
 */
export async function runStoryGoalLoop(
  workId: number,
  config: Partial<StoryGoalConfig> = {},
  sender?: WebContents
): Promise<void> {
  if (activeLoops.has(workId)) {
    throw new Error('该作品已有目标循环在运行')
  }
  const fullConfig: StoryGoalConfig = { ...DEFAULT_STORY_GOAL_CONFIG, ...config }
  const controller = new AbortController()
  activeLoops.set(workId, controller)

  goalRoutineDAO.ensure(workId)
  goalRoutineDAO.update(workId, {
    status: 'running',
    max_turns: fullConfig.maxTurns,
    turn_count: 0,
    current_phase: 'outline',
    goal_met: false,
    goal_config_json: JSON.stringify(fullConfig)
  })

  let turn = 0
  let phase: Phase = 'outline'
  let lastCheck: GoalCheckResult | undefined

  const emit = (message: string, status: string) => {
    const ev: GoalProgressEvent = {
      workId, turn, maxTurns: fullConfig.maxTurns, phase, status, check: lastCheck, message
    }
    safeSend(sender, 'goal:progress', ev)
  }

  appLogger.info('goal_routine', '目标循环启动', { workId, config: fullConfig })

  try {
    while (turn < fullConfig.maxTurns) {
      if (controller.signal.aborted) {
        goalRoutineDAO.setStatus(workId, 'cancelled')
        emit('已取消', 'cancelled')
        return
      }

      turn++
      goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })

      try {
        if (phase === 'outline') {
          const res = await ensureBeats(workId, fullConfig.goalDescription, controller.signal)
          emit(res.created > 0 ? `生成 ${res.created} 个节拍` : (res.error ?? '节拍已存在'), 'running')
          phase = 'draft'
        } else if (phase === 'draft') {
          const beat = nextEmptyBeat(workId)
          if (!beat) {
            phase = 'check'
            emit('所有节拍已有正文，进入检查', 'running')
          } else {
            const gen = await generateBeatBody(workId, beat.id, controller.signal, fullConfig.goalDescription)
            goalRoutineDAO.appendTurn({
              work_id: workId, turn_no: turn, phase, action: 'draft',
              target_chapter_id: beat.id,
              summary: gen.success ? `生成「${beat.title}」${gen.wordCount}字` : (gen.error ?? '生成失败')
            })
            emit(gen.success ? `生成「${beat.title}」${gen.wordCount}字` : `节拍「${beat.title}」生成失败：${gen.error}`, 'running')
            phase = 'check'
          }
        } else if (phase === 'check') {
          lastCheck = await checkStoryGoal(workId, fullConfig, controller.signal)
          goalRoutineDAO.update(workId, {
            last_ai_percent: lastCheck.aiPercent,
            last_quality_score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : null,
            goal_met: lastCheck.met
          })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase: 'check', action: 'check',
            ai_percent_before: lastCheck.aiPercent,
            score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : lastCheck.aiPercent,
            summary: lastCheck.met ? '目标达成' : lastCheck.reasons.join('；')
          })

          if (lastCheck.met) {
            goalRoutineDAO.setStatus(workId, 'goal_met')
            emit(`目标达成：质量${lastCheck.qualityScore} · AI${lastCheck.aiPercent}% · 节拍${lastCheck.contentBeats}/${lastCheck.totalBeats} · 字数${lastCheck.totalWords}`, 'goal_met')
            return
          }

          emit(`未达标：${lastCheck.reasons.join('；')}`, 'running')
          // 仍有空节拍 → 继续 draft；否则进入 fix 多维度修复
          phase = nextEmptyBeat(workId) ? 'draft' : 'fix'
        } else if (phase === 'fix') {
          // 多维度修复：按未达标维度选择动作
          const reasons = lastCheck?.reasons.join('；') ?? ''
          let fixTarget: { id: number; title: string } | null = null
          let extraHint = ''
          let actionLabel = 'fix'

          if (/字数不足/.test(reasons)) {
            // 字数不足 → 取最短节拍扩写
            fixTarget = shortestBeat(workId)
            extraHint = '当前字数不足目标，请在保持情节基础上扩充细节、对话与场景描写，增加篇幅。'
            actionLabel = 'expand'
          } else if (/AI 特征.*超过上限|anti-AI 规则违规/.test(reasons)) {
            // 去AI 不达标 → 取高 AI 节拍重写（生成式，带去AI 引导）
            fixTarget = highestAiBeat(workId)
            extraHint = '当前 AI 特征偏高，请改写句式节奏、用更口语/具象/低频的词，打破均匀句长与模板连接词，降低机器写作痕迹。'
            actionLabel = 'deai'
          } else {
            // 质量分/门禁不达标 → 取最短节拍重写提升质量
            fixTarget = shortestBeat(workId)
            extraHint = '当前质量分偏低或门禁未过，请提升开篇吸引力、视角一致性、情节逻辑与钩子，修复诊断指出的问题。'
            actionLabel = 'quality'
          }

          if (!fixTarget) {
            phase = 'check'
            emit('无可修复节拍，进入检查', 'running')
          } else {
            // 清空正文以触发重新生成
            volumeChapterDAO.updateChapter(fixTarget.id, { content: '', word_count: 0, status: 'draft' })
            const gen = await generateBeatBody(workId, fixTarget.id, controller.signal, fullConfig.goalDescription, extraHint)
            goalRoutineDAO.appendTurn({
              work_id: workId, turn_no: turn, phase: 'fix', action: actionLabel,
              target_chapter_id: fixTarget.id,
              summary: gen.success
                ? `${actionLabel === 'expand' ? '扩写' : actionLabel === 'deai' ? '去AI重写' : '质量重写'}「${fixTarget.title}」${gen.wordCount}字`
                : `重写失败：${gen.error}`
            })
            emit(gen.success ? `${actionLabel === 'expand' ? '扩写' : actionLabel === 'deai' ? '去AI重写' : '质量重写'}「${fixTarget.title}」` : `重写失败：${gen.error}`, 'running')
            phase = 'check'
          }
        }
      } catch (e) {
        if (controller.signal.aborted) {
          goalRoutineDAO.setStatus(workId, 'cancelled')
          emit('已取消', 'cancelled')
          return
        }
        const msg = e instanceof Error ? e.message : String(e)
        appLogger.error('goal_routine', '轮次异常', { workId, turn, error: msg })
        goalRoutineDAO.appendTurn({
          work_id: workId, turn_no: turn, phase, action: 'error', summary: msg
        })
        emit(`轮次异常：${msg}`, 'running')
        // 异常不立即终止，下一轮继续；靠 maxTurns 兜底
      }
    }

    // 轮次上限
    goalRoutineDAO.setStatus(workId, 'timeout')
    emit(`已达轮次上限 ${fullConfig.maxTurns}，停止`, 'timeout')
  } finally {
    activeLoops.delete(workId)
  }
}
