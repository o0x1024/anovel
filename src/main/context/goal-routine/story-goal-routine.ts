/**
 * 短故事目标循环运行器 —— loop-engineering 的 automations + 状态机。
 *
 * 状态机（目标驱动流水线 + 验收后修复）：
 *   materialize_settings → 从创作目标直接沉淀核心设定
 *   generate_character_cards → 生成主角人设卡片
 *   story_engine_gate → 固化人物欲望、两难、代价与题材因果
 *   generate_beats → 生成完整节拍大纲
 *   generate_title_hook → 基于节拍大纲生成爆款书名与导语
 *   overall_self_check → 核心设定整体自检
 *   draft_body → 顺序生成全部正文
 *   goal_check → 统一验收目标维度
 *   repair_plan/repair_execute → 结构化修复后回到验收
 *
 * 安全 guardrail：轮次硬上限、AbortController 可取消、每轮写轮次记忆、
 * 重启后由用户手动断点续跑（paused 态可恢复）。
 */
import { BrowserWindow, type WebContents } from 'electron'
import { appLogger } from '../../logger/app-logger'
import {
  volumeChapterDAO,
  goalRoutineDAO,
  coreSettingDAO,
  workDAO,
  appPreferenceDAO,
  storyHarnessDAO
} from '../../db'
import { modelService } from '../../model'
import { CHARACTER_CARDS_AI_PROMPT } from '../writing-techniques'
import { buildWorkContext } from '../work-context'
import {
  parseCharacterCardsFromAi,
  sanitizeCharacterCards,
  saveCharacterCards,
  validateCharacterCards
} from '../character-cards'
import { buildSettingsQualityInput, recordQualityCheck } from '../settings-quality'
import { STORY_OVERALL_CHECK_SYSTEM_PROMPT } from '../story-settings-quality'
import { runIncubatorGate } from '../incubator/gate-check'
import { runGateFix } from '../incubator/gate-fix'
import { freezeIncubatorStorylineVersion } from '../incubator/freeze-version'
import {
  parseChapterSuggestions,
  type ContinuityContract,
  type ParsedChapter
} from '../parse-chapters'
import { outlineConstraintsForWordTarget } from '../../../shared/outline-constraints'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../../shared/writing-plan-presets'
import { loadWritingPlan } from '../writing-plan'
import { STORY_INCUBATOR_ANALYSIS_PROMPTS } from '../../../shared/story-incubator-prompts'
import { STORY_SLOT_KEYS, getIncubatorSlotLabel, type IncubatorSlotKey } from '../../../shared/incubator-slots'
import { parseExpansionVersions, type ExpansionVersion } from '../parse-expansion'
import { parseIncubatorVariants, type IncubatorVariant } from '../parse-variants'
import { updateDraftSlotContent } from '../incubator/update-slot'
import { incubatorDraftSlotDAO } from '../../db/dao/incubator'
import {
  checkStoryGoal,
  DEFAULT_STORY_GOAL_CONFIG,
  failedCriticalStoryMetrics,
  type StoryGoalConfig,
  type GoalCheckResult
} from './story-goal-checker'
import {
  commitStoryBodyCandidate,
  generateBeatBody,
  extractNarrativeMemoryAfterGeneration
} from './story-goal-doer'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { parseStoryQualityAiScoreBreakdown } from '../../../shared/story-quality-score'
import { normalizeModelBodyOutput, stripDeterministicAiPatterns } from '../../../shared/normalize-body-text'
import { QUALITY_APPLY_FIXES_PROMPT } from '../chapter-quality'
import { STYLE_REWRITE_INSTRUCTION, countEmDashes, stripEmDashes } from '../anti-ai-rules'
import { runConsistencyGate } from '../consistency-gate'
import {
  bindGoalLoopModelOpts,
  clearGoalLoopModelOpts,
  getGoalLoopModelOpts,
  storyGoalModelOpts,
  withGoalLoopModelOptions
} from './story-goal-model'
import {
  GOAL_ROUTINE_PHASE_ORDER,
  isGoalRoutinePhase,
  type GoalRoutinePhase
} from '../../../shared/goal-routine-phases'
import {
  normalizeStoryCategoryTags,
  storyCategoryPromptSection,
  storyCategoryTagsToStorage,
  type StoryCategoryTags
} from '../../../shared/story-category-tags'
import { storyHotWordPromptSection } from '../../../shared/story-hot-words'
import { fuzzyReplace } from '../../../shared/fuzzy-match'
import { parseQualityConclusion, PASS_SCORE_THRESHOLD, type QualityConclusion } from '../settings-quality-conclusion'
import { selectPreferredTitleHook, compareRepairCandidate } from './story-pairwise-evaluator'
import {
  parseStructuredModelContent,
  requestStructuredModelOutput
} from './structured-model-output'
import {
  requestQualityEvaluatorEvidence,
  requireQualityEvaluatorEvidence
} from './quality-evaluator-policy'
import { clearChapterNarrativeMemory } from '../memory-cleanup'
import { recordTasteChoice } from '../taste-profile'
import { bodyWordCountBounds, countWords } from '../../../shared/body-word-target'
import { ensureStoryEngine } from './story-engine-gate'
import { ensureStoryContract, formatStoryContractForPrompt, getStoryContract } from './story-contract'
import { EMOTION_CONTRACT_JSON_SHAPE, ensureEmotionEngine } from './emotion-engine'
import {
  EMOTION_CONTRACT_ENUM_RULE,
  validateEmotionContract,
  type EmotionBlindAssessment
} from '../../../shared/emotion-contract'
import {
  assessChapterEmotion,
  ensureChapterEmotionOutcome,
  isEmotionAssessmentAcceptedForTransition
} from './emotion-gate'
import {
  formatGenrePolicy,
  normalizeTensionPlanForBeat,
  resolveStoryGenrePolicy,
  tensionCurveForBeat,
  validateTensionPlans
} from './story-genre-policy'
import {
  filterStoryRepairLedgerIssues,
  routeStoryForensicRepair,
  stalledStoryForensicEscalationCount
} from './story-forensic-repair'
import type { StoryForensicIssue } from './story-whole-evaluator'
import {
  BEAT_CONTRACT_MAX_TOKENS,
  BEAT_SKELETON_MAX_TOKENS,
  BEAT_STAGE_MAX_ATTEMPTS,
  beatGateContractRepairIndexes,
  beatGateIssueSignature,
  beatGateIssuesForIndex,
  beatGateIssuesForLayer,
  beatGateNeedsSkeletonModelRepair,
  beatGateRepairIndexes,
  beatGateResolvedTargetCount,
  type BeatGateRecovery,
  compactBeatSkeletons,
  exactStageCountError,
  mergeStagedBeat,
  mergeStoryBlueprintDiagnosis,
  sanitizeBeatSkeleton,
  storyBeatStageKey
} from './story-beat-staging'
import { retentionEvaluationRules, retentionPackagingRules, retentionPlanningRules } from './reader-retention'
import {
  validateStoryBoundaryContracts,
  validateStoryContinuityContracts
} from '../../../shared/story-hard-guards'
import {
  routeStoryContinuityEscalation,
  type StoryContinuityEscalationRoute
} from './story-continuity-escalation'
import type { StoryContinuityRepairEvent } from './story-goal-doer'
import {
  STRUCTURAL_REPAIR_MAX_ATTEMPTS,
  STORY_ROUTINE_FAILURE_LIMIT,
  StoryCandidateFailureError,
  StructuralRepairError,
  classifyStructuralRepairParseFailure,
  routineFailureSignature,
  structuralRepairTokenBudget
} from './story-structural-repair-policy'
import { GoalPhaseExhaustedError } from './goal-phase-error'
import {
  detectStoryTextIntegrityIssues,
  repairDeterministicStorySentences,
  resolveStoryModelCapability,
  stableStoryHash,
  storyHarnessIssueKey
} from '../../../shared/story-harness'
import { requireGoalTurnLimit } from '../../../shared/goal-turn-limit'
import {
  patchStoryGoalRuntimeState as patchRuntimeState,
  readStoryGoalRuntimeState as readRuntimeState,
  type RepairPlan,
  type RoutineRuntimeState,
  type TitleHookCandidate
} from './story-goal-runtime'
import {
  classifyWorkflowError,
  waitForWorkflowRetry,
  type ClassifiedWorkflowError
} from '../../workflow/workflow-errors'
import {
  clearWorkflowExecutionContext,
  setWorkflowExecutionContext
} from '../../workflow/workflow-execution-context'
import { ensureWorkflowModelContract } from '../../workflow/workflow-model-contract'

export type { TitleHookCandidate } from './story-goal-runtime'

import {
  freezeStoryline,
  generateCharacterCards,
  incubateStoryline,
  materializeStorySettings,
  runStorylineGate,
  slotContext,
  STORY_SETTING_PROMPTS,
  STORY_SETTING_TYPES
} from './story-goal-setup'
import { ensureBeats } from './story-goal-beats'
import {
  applyDeterministicSentenceRepair,
  buildRepairPlan,
  cleanupEmDashesAfterPassedGate,
  diagnoseAndFixUntilPass,
  ensureFrozenStoryPovModes,
  executeRepairPlan,
  nextEmptyBeat
} from './story-goal-repair'

export { freezeStoryline, incubateStoryline, runStorylineGate } from './story-goal-setup'

export type Phase = GoalRoutinePhase

export interface GoalProgressEvent {
  workId: number
  turn: number
  maxTurns: number
  phase: Phase
  status: string
  check?: GoalCheckResult
  message: string
}

// v7：设置、包装、情绪账本与结构修复统一拆分协议重试、只读评估和语义修订轮次。
const STORY_REPAIR_PROTOCOL_VERSION = 7

const activeLoops = new Map<number, AbortController>()
const MAX_STAGNANT_CHECKS = 2
const MAX_BEAT_GENERATION_ROUNDS = 4
const MAX_OVERALL_SETTING_REPAIR_ROUNDS = 3


async function compensatePendingStoryMemory(workId: number, signal?: AbortSignal): Promise<void> {
  const runtime = readRuntimeState(workId)
  const pending = [...new Set(runtime.pendingMemoryChapterIds ?? [])]
  const chapterId = pending[0]
  if (chapterId == null) return
  if (signal?.aborted) throw new Error('已取消')
  const attempts = { ...(runtime.memoryCompensationAttempts ?? {}) }
  const key = String(chapterId)
  if ((attempts[key] ?? 0) >= 2) {
    patchRuntimeState(workId, {
      pendingMemoryChapterIds: pending.filter(id => id !== chapterId),
      memoryCompensationAttempts: attempts
    })
    return
  }
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter?.content?.trim()) {
    patchRuntimeState(workId, { pendingMemoryChapterIds: pending.filter(id => id !== chapterId) })
    return
  }
  try {
    await extractNarrativeMemoryAfterGeneration(workId, chapterId, chapter.content, signal)
    delete attempts[key]
    patchRuntimeState(workId, {
      pendingMemoryChapterIds: pending.filter(id => id !== chapterId),
      memoryCompensationAttempts: attempts
    })
    appLogger.info('goal_routine', '短故事叙事记忆旁路补偿成功', { workId, chapterId })
  } catch (error) {
    if (signal?.aborted) throw error
    attempts[key] = (attempts[key] ?? 0) + 1
    patchRuntimeState(workId, { pendingMemoryChapterIds: pending, memoryCompensationAttempts: attempts })
    appLogger.warn('goal_routine', '短故事叙事记忆旁路补偿未通过，不回滚正文', {
      workId, chapterId, attempts: attempts[key], error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function isGoalLoopRunning(workId: number): boolean {
  return activeLoops.has(workId)
}

export function cancelGoalLoop(workId: number): boolean {
  const controller = activeLoops.get(workId)
  if (!controller) return false
  goalRoutineDAO.setStatus(workId, 'cancelled')
  controller.abort()
  return true
}

/** 关闭应用时调用：中止所有运行中的目标循环并标记为 paused 以便断点续跑 */
export function cancelAllGoalLoops(): void {
  for (const [workId, controller] of activeLoops) {
    controller.abort()
    try {
      goalRoutineDAO.setStatus(workId, 'paused')
    } catch { /* ignore */ }
  }
  activeLoops.clear()
}

function broadcastProgress(channel: string, payload: unknown): void {
  // 目标循环进度需要被所有窗口/视图感知（如作品列表、编辑器），所以广播到全部窗口
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch { /* 接收方已销毁 */ }
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}

function buildTitleHookPrompt(workId: number, goal: string): string {
  const slotsContext = slotContext(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const outlineContext = chapters
    .filter(c => c.outline?.trim())
    .map(c => `### ${c.title}\n${c.outline?.trim()}`)
    .join('\n\n')
  return [
    `【大纲孵化内容】\n${slotsContext || '（暂无大纲孵化内容）'}`,
    `【各节拍情节大纲】\n${outlineContext || '（暂无节拍大纲内容）'}`,
    `【故事核心与补充要求】\n${goal.trim() || '（无额外补充）'}`
  ].join('\n\n')
}

function parseTitleHookCandidates(value: Record<string, unknown>): TitleHookCandidate[] {
  if (!Array.isArray(value.candidates)) throw new Error('candidates 必须是数组')
  const candidates = value.candidates
    .map((item): TitleHookCandidate | null => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      const title = typeof row.title === 'string' ? row.title.trim() : ''
      const hook = typeof row.hook === 'string' ? row.hook.trim() : ''
      if (!title || !hook) return null
      const summary = typeof row.summary === 'string' ? row.summary.trim() : ''
      const fallbackText = [title, hook, summary].join('\n')
      const candidate: TitleHookCandidate = {
        title,
        hook,
        tags: normalizeStoryCategoryTags(row.tags, fallbackText)
      }
      if (typeof row.type === 'string') candidate.type = row.type.trim()
      if (summary) candidate.summary = summary
      return candidate
    })
    .filter((x): x is TitleHookCandidate => x != null)
  if (candidates.length !== 5) throw new Error(`书名导语候选必须为 5 项，实际 ${candidates.length} 项`)
  return candidates
}

function applyTitleHook(workId: number, picked: TitleHookCandidate): void {
  workDAO.update(workId, {
    title: picked.title,
    description: picked.hook,
    genre: picked.tags.main_category || undefined,
    tags: storyCategoryTagsToStorage(picked.tags)
  })
}

const TITLE_HOOK_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array', minItems: 5, maxItems: 5,
      items: {
        type: 'object',
        required: ['title', 'hook', 'type', 'summary', 'tags'],
        properties: {
          title: { type: 'string' }, hook: { type: 'string' }, type: { type: 'string' }, summary: { type: 'string' },
          tags: { type: 'object' }
        }
      }
    }
  }
}
const TITLE_HOOK_GATE_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['valid_indices', 'issues'],
  properties: {
    valid_indices: { type: 'array', items: { type: 'integer' } },
    issues: { type: 'array', items: { type: 'string' } }
  }
}

async function generateTitleHook(
  workId: number,
  goal: string,
  signal?: AbortSignal
): Promise<{ preferred: TitleHookCandidate; preferredIndex: number; candidates: TitleHookCandidate[] }> {
  assertNotAborted(signal)
  let lastIssue = ''
  for (let round = 1; round <= 3; round++) {
    const candidates = await requestStructuredModelOutput<TitleHookCandidate[]>({
      workId,
      label: '短故事书名导语候选',
      signal,
      schema: TITLE_HOOK_RESPONSE_SCHEMA,
      validate: parseTitleHookCandidates,
      request: (attempt, error) => modelService.chat(
        withGoalLoopModelOptions(workId, {
          prompt: [
            buildTitleHookPrompt(workId, goal),
            lastIssue ? `【上一轮硬伤】${lastIssue}` : '',
            attempt > 1 ? `【协议重试】${error}。压缩每条导语并返回完整 JSON。` : ''
          ].filter(Boolean).join('\n\n'),
          systemPrompt: [
            '你是番茄短故事的顶流爆款编辑，深谙爆款流量密码。',
            '基于大纲孵化设定、节拍大纲和创作目标，生成 5 个能瞬间抓住读者眼球、让其产生极强追读冲动的短故事书名与导语组合。',
            '书名必须强网感、直击人性弱点、带爽感/反差/悬念/场景刺激。',
            '导语是放在全篇正文最开头、独立于编号节拍之外的钩子场景，不是剧情摘要。',
            '导语 150-300 字，前三句建立明确冲突或异常；叙事视角服从用户目标与正文设定，未指定时优先第一人称；结尾留下具体追问。',
            '导语必须包含当下动作、对话或感官细节，展示一张牌但至少隐藏两张核心牌。',
            '禁止按时间顺序概括全篇；禁止罗列完整计划、全部证据、所有帮手和高潮解法；禁止提前宣布反派如何失败。',
            '禁止“从A到B再到C，每一步都在我的计划里”式总结。读者应知道冲突和异常应对，但不知道终局答案。',
            retentionPackagingRules('story'),
            storyHotWordPromptSection(),
            storyCategoryPromptSection(),
            '必须且只能输出合法 JSON：{"candidates":[{"title":"书名","hook":"导语正文","type":"类型","summary":"一句点评","tags":{"main_category":"主分类","plot":["情节分类"],"character":["角色分类"],"emotion":["情绪分类"],"setting":["背景分类"]}}]}'
          ].join('\n'),
          workId,
          step: 'story_title_hook_gen',
          enrichWorkContext: false,
          forceThinkingDisabled: true,
          responseSchema: { name: 'story_title_hook_candidates', schema: TITLE_HOOK_RESPONSE_SCHEMA, strict: false },
          structuredOutputMode: 'prompt_json'
        }),
        { stream: false, signal }
      )
    })
    const gateEvidence = await requestQualityEvaluatorEvidence<{
      validIndices: number[]
      issues: string[]
    }>({
      workId,
      label: '短故事导语防剧透门禁',
      signal,
      request: (attempt, error) => modelService.chat(
        withGoalLoopModelOptions(workId, {
          workId,
          step: 'story_title_hook_gate',
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          temperature: 0,
          maxTokens: 1000,
          forceThinkingDisabled: true,
          responseSchema: { name: 'story_title_hook_gate', schema: TITLE_HOOK_GATE_RESPONSE_SCHEMA, strict: false },
          structuredOutputMode: 'prompt_json',
          systemPrompt: [
            '你是短故事导语防剧透门禁。逐项判断是否为具体钩子场景，而非全篇摘要。',
            '若导语罗列完整计划、全部证据/帮手、高潮解法、反派最终下场，或只用概括句交代故事，必须淘汰。',
            '只输出 JSON：{"valid_indices":[0],"issues":["候选1泄露..."]}'
          ].join('\n'),
          prompt: [
            `${formatStoryContractForPrompt(workId)}\n\n【候选】\n${JSON.stringify(candidates.map((candidate, index) => ({ index, title: candidate.title, hook: candidate.hook })), null, 2)}`,
            attempt > 1 ? `【协议重试】${error}。只返回完整 JSON。` : ''
          ].filter(Boolean).join('\n\n')
        }),
        { stream: false, signal }
      ),
      parse: content => parseStructuredModelContent({
        content,
        schema: TITLE_HOOK_GATE_RESPONSE_SCHEMA,
        validate: value => {
          if (!Array.isArray(value.valid_indices) || !Array.isArray(value.issues)) {
            throw new Error('门禁缺少 valid_indices 或 issues')
          }
          const validIndices = value.valid_indices.map(Number)
          if (validIndices.some(index => !Number.isInteger(index) || index < 0 || index >= candidates.length)) {
            throw new Error('valid_indices 包含越界候选')
          }
          return {
            validIndices: [...new Set(validIndices)],
            issues: value.issues.map(String).map(item => item.trim()).filter(Boolean)
          }
        }
      }).value
    })
    const verdict = requireQualityEvaluatorEvidence(gateEvidence, '短故事导语防剧透门禁')
    const valid = verdict.validIndices.map(index => candidates[index])
    if (valid.length === 0) {
      lastIssue = verdict.issues.join('；') || '全部候选泄露终局或属于剧情摘要'
      continue
    }
    const picked = await selectPreferredTitleHook(workId, goal, valid, signal)
    return { preferred: picked, preferredIndex: Math.max(0, valid.indexOf(picked)), candidates: valid }
  }
  throw new GoalPhaseExhaustedError(`书名导语连续3轮未通过防剧透门禁：${lastIssue}`)
}

export function applyGoalTitleHookSelection(workId: number, candidateIndex: number): TitleHookCandidate {
  const runtime = readRuntimeState(workId)
  const candidates = runtime.titleHookCandidates ?? []
  if (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= candidates.length) {
    throw new Error('书名导语候选不存在或已过期')
  }
  const picked = candidates[candidateIndex]
  const isNovel = workDAO.getById(workId)?.work_type === 'novel'
  if (isNovel) {
    workDAO.update(workId, { title: picked.title, description: picked.hook })
  } else {
    applyTitleHook(workId, picked)
  }
  recordTasteChoice(
    workId,
    'goal_title_hook_pick',
    `${picked.title}｜${picked.hook.slice(0, 140)}`
  )
  const state = goalRoutineDAO.getByWork(workId)
  goalRoutineDAO.appendTurn({
    work_id: workId,
    turn_no: state?.turn_count ?? 0,
    phase: 'generate_title_hook',
    action: 'title_hook_selected',
    summary: `作者确认书名「${picked.title}」`
  })
  patchRuntimeState(workId, {
    titleHookCandidates: undefined,
    titleHookPreferredIndex: undefined
  })
  goalRoutineDAO.update(workId, {
    status: 'paused',
    current_phase: isNovel ? 'draft_body' : 'overall_self_check'
  })
  return picked
}

async function runOverallSelfCheck(
  workId: number,
  signal?: AbortSignal
): Promise<{ report: string; conclusion: QualityConclusion | null }> {
  assertNotAborted(signal)
  const prompt = buildSettingsQualityInput(workId)
  if (!prompt.replace(/（尚未设定）|（无活跃锚点）/g, '').trim()) throw new Error('请先填写故事方向或核心设定后再运行自检')
  const evidence = await requestQualityEvaluatorEvidence<{ report: string; conclusion: QualityConclusion }>({
    workId,
    label: '短故事核心设定整体自检',
    signal,
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: [
          prompt,
          attempt > 1 ? `【协议重试】${error}。保留审查结论，但必须给出可解析的最终结论字段。` : ''
        ].filter(Boolean).join('\n\n'),
        systemPrompt: STORY_OVERALL_CHECK_SYSTEM_PROMPT,
        workId,
        step: 'settings_overall_check',
        enrichWorkContext: false,
        forceThinkingDisabled: true
      }),
      { stream: false, signal }
    ),
    parse: report => {
      const conclusion = parseQualityConclusion(report)
      if (!conclusion) throw new Error('整体自检缺少可解析的 verdict、overallScore 或 blockingCount')
      return { report, conclusion }
    }
  })
  const result = requireQualityEvaluatorEvidence(evidence, '短故事核心设定整体自检')
  recordQualityCheck(workId, {
    overall: { report: result.report, checkedAt: new Date().toISOString() }
  })
  return result
}

async function repairSettingsFromOverallCheck(
  workId: number,
  report: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number> {
  const mainline = coreSettingDAO.getByType(workId, 'idea')?.content?.trim() || slotContext(workId)
  let revised = 0

  for (const type of STORY_SETTING_TYPES) {
    assertNotAborted(signal)
    const current = coreSettingDAO.getByType(workId, type)?.content?.trim() ?? ''
    const otherSettings = STORY_SETTING_TYPES
      .filter(other => other !== type)
      .map(other => {
        const text = coreSettingDAO.getByType(workId, other)?.content?.trim()
        return text ? `## ${other}\n${text}` : ''
      })
      .filter(Boolean)
      .join('\n\n')

    onProgress?.(`正在根据整体自检修订「${type}」`)
    const res = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: `settings_${type}_revise`,
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        systemPrompt: [
          STORY_SETTING_PROMPTS[type],
          '这是门禁修订，不是重新发散。保留已自洽内容，只修复报告指出的阻塞问题；输出完整修订后的 Markdown，不要解释。'
        ].join('\n\n'),
        prompt: [
          `【短故事主线】\n${mainline}`,
          `【当前 ${type}】\n${current || '（空）'}`,
          otherSettings ? `【其他已确定设定】\n${otherSettings}` : '',
          `【整体自检报告】\n${report}`
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!res.success || !res.content?.trim()) {
      throw new Error(res.error || `整体自检修订 ${type} 失败`)
    }
    if (res.content.trim() !== current) {
      coreSettingDAO.upsert(workId, type, res.content.trim())
      revised++
    }
  }
  return revised
}

/** 构造短故事节拍拆解的 system prompt（复刻 ChaptersPanel 的 story 分支） */
const VALID_PHASES: Phase[] = GOAL_ROUTINE_PHASE_ORDER

function isResumable(status: string | null | undefined): boolean {
  return status === 'paused' || status === 'running' || status === 'waiting'
    || status === 'cancelled' || status === 'timeout' || status === 'error'
}

function goalCheckComposite(check: GoalCheckResult): number {
  const quality = check.qualityScore >= 0 ? check.qualityScore : 0
  return Math.round(
    (quality + check.emotionScore + check.goalMatchScore + check.overallStoryScore + check.previewHookScore + check.proseReadScore) / 6
    - check.gateBlockers * 5
    - Math.min(20, check.antiAiViolations)
  )
}

function goalCheckSignature(check: GoalCheckResult): string {
  return check.reasons
    .map(reason => reason.replace(/\d+(?:\.\d+)?/g, '#').split('：')[0])
    .sort()
    .join('|')
}

/** 存在未完成进度、应续跑而非从头孵化 */
export function shouldResumeGoalLoop(workId: number): boolean {
  const existing = goalRoutineDAO.getByWork(workId)
  if (!existing || existing.goal_met) return false
  if (!isResumable(existing.status)) return false
  if (existing.status === 'timeout') return true
  if (existing.status === 'paused' || existing.status === 'waiting'
    || existing.status === 'cancelled' || existing.status === 'error') {
    return (existing.turn_count ?? 0) > 0 || Boolean(existing.current_phase)
  }
  return false
}

/**
 * 运行短故事目标循环，直到目标达成或轮次上限。
 * 非阻塞：在后台异步跑，通过 sender 发 goal:progress 事件。
 *
 * @param resume true 时从 DB 中保存的 phase/turn/config 继续执行（断点续跑）。
 */
export async function runStoryGoalLoop(
  workId: number,
  config: Partial<StoryGoalConfig> = {},
  sender?: WebContents,
  resume = false,
  forcePhase?: Phase
): Promise<void> {
  if (activeLoops.has(workId)) {
    throw new Error('该作品已有目标循环在运行')
  }

  const existing = goalRoutineDAO.getByWork(workId)
  let fullConfig: StoryGoalConfig
  let turn: number
  let phase: Phase
  const explicitPhase = forcePhase && isGoalRoutinePhase(forcePhase) ? forcePhase : undefined

  if (resume && existing && isResumable(existing.status)) {
    const saved = existing.goal_config_json
      ? { ...DEFAULT_STORY_GOAL_CONFIG, ...JSON.parse(existing.goal_config_json) as Partial<StoryGoalConfig> }
      : { ...DEFAULT_STORY_GOAL_CONFIG }
    fullConfig = { ...saved, ...config }
    turn = existing.turn_count ?? 0
    const savedPhase = existing.current_phase as Phase
    phase = explicitPhase ?? (VALID_PHASES.includes(savedPhase) ? savedPhase : 'materialize_settings')
    appLogger.info('goal_routine', '目标循环断点续跑', { workId, phase, turn, config: fullConfig })
  } else if (explicitPhase && existing) {
    const saved = existing.goal_config_json
      ? { ...DEFAULT_STORY_GOAL_CONFIG, ...JSON.parse(existing.goal_config_json) as Partial<StoryGoalConfig> }
      : { ...DEFAULT_STORY_GOAL_CONFIG }
    fullConfig = { ...saved, ...config }
    turn = 0
    phase = explicitPhase
    appLogger.info('goal_routine', '目标循环从指定步骤启动新一轮', { workId, phase, turn, config: fullConfig })
  } else {
    fullConfig = { ...DEFAULT_STORY_GOAL_CONFIG, ...config }
    turn = 0
    phase = explicitPhase ?? 'materialize_settings'
  }

  fullConfig.maxTurns = requireGoalTurnLimit(fullConfig.maxTurns)
  const startupRuntime = existing?.state_json
    ? JSON.parse(existing.state_json) as RoutineRuntimeState
    : {}
  const upgradingRepairProtocol = resume
    && startupRuntime.repairProtocolVersion !== STORY_REPAIR_PROTOCOL_VERSION
  if (upgradingRepairProtocol) {
    // 旧协议的修复计划不包含权威边界键、发布兑现与合规证据。
    // 升级后必须先回到同稿只读终审重新路由；正文、候选与版本历史全部保留。
    phase = 'goal_check'
  }

  const run = goalRoutineDAO.beginRun({
    workId,
    workflowType: 'story',
    resume,
    maxTurns: fullConfig.maxTurns,
    currentPhase: phase,
    goalConfigJson: JSON.stringify(fullConfig)
  })
  turn = run.turn_count
  phase = (run.current_phase as Phase) || phase

  try {
    const frozen = ensureWorkflowModelContract(
      run.id,
      storyGoalModelOpts(fullConfig)
    )
    if (frozen.created) {
      goalRoutineDAO.appendTurn({
        work_id: workId,
        turn_no: turn,
        phase,
        action: 'model_contract_frozen',
        summary: `已冻结本次运行的模型、协议与生成参数合同 ${frozen.hash.slice(0, 12)}`
      })
    }
  } catch (error) {
    goalRoutineDAO.setStatus(workId, 'paused')
    goalRoutineDAO.appendTurn({
      work_id: workId,
      turn_no: turn,
      phase,
      action: 'model_contract_preflight_failed',
      summary: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  const controller = new AbortController()
  activeLoops.set(workId, controller)
  bindGoalLoopModelOpts(workId, fullConfig)

  goalRoutineDAO.update(workId, {
    status: 'running',
    max_turns: fullConfig.maxTurns,
    turn_count: turn,
    current_phase: phase,
    goal_met: false,
    goal_config_json: JSON.stringify(fullConfig)
  })
  patchRuntimeState(workId, {
    repairProtocolVersion: STORY_REPAIR_PROTOCOL_VERSION,
    ...(upgradingRepairProtocol
      ? {
          terminalReason: undefined,
          repairPlan: undefined,
          executionFailure: undefined,
          wholeAuditCount: 0,
          forensicRepairStall: undefined
        }
      : {})
  })

  let lastCheck: GoalCheckResult | undefined
  const emit = (message: string, status: string) => {
    const ev: GoalProgressEvent = {
      workId, turn, maxTurns: fullConfig.maxTurns, phase, status, check: lastCheck, message
    }
    patchRuntimeState(workId, {
      liveProgress: {
        turn,
        phase,
        status,
        message,
        updatedAt: new Date().toISOString()
      }
    })
    appLogger.info('goal_progress', message, { workId, turn, phase, status })
    broadcastProgress('goal:progress', ev)
  }

  const runGoalCheckWithVisibleProgress = async (): Promise<GoalCheckResult> => {
    let activeMessage = '目标验收：正在准备质量、门禁与整篇盲读'
    let activeSince = Date.now()
    const reportProgress = (message: string) => {
      activeMessage = message
      activeSince = Date.now()
      emit(message, 'running')
    }
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - activeSince) / 1000))
      emit(`${activeMessage}（本步已耗时 ${elapsedSeconds} 秒，后台仍在处理）`, 'running')
    }, 15_000)
    try {
      return await checkStoryGoal(
        workId,
        fullConfig,
        controller.signal,
        reportProgress
      )
    } finally {
      clearInterval(heartbeat)
    }
  }

  const recordContinuityEvent = (
    chapterId: number,
    chapterTitle: string,
    event: StoryContinuityRepairEvent
  ) => {
    const action = event.type === 'rejected'
      ? 'continuity_gate'
      : event.type === 'repaired'
        ? 'continuity_repair'
        : event.type === 'passed'
          ? 'continuity_pass'
          : 'continuity_retry'
    const summary = event.type === 'rejected'
      ? `「${chapterTitle}」候选第 ${event.candidateRound} 轮连续性门禁未通过，已保存候选版本：${event.blockers.join('；')}`
      : event.type === 'repaired'
        ? `「${chapterTitle}」已按上一轮阻塞证据生成第 ${event.candidateRound} 轮定向修复候选（${event.wordCount}字）`
        : event.type === 'passed'
          ? `「${chapterTitle}」候选第 ${event.candidateRound} 轮跨拍连续性门禁通过`
          : `「${chapterTitle}」连续性评估器无效，保留候选并重试审计：${event.blockers.join('；')}`
    goalRoutineDAO.appendTurn({
      work_id: workId,
      turn_no: turn,
      phase,
      action,
      target_chapter_id: chapterId,
      summary
    })
  }

  const escalateContinuityFailure = async (
    chapterId: number,
    blockers: string[],
    attempts: number
  ): Promise<StoryContinuityEscalationRoute> => {
    const sourcePhase = phase
    const chapters = volumeChapterDAO.listChaptersByWork(workId)
    const runtime = readRuntimeState(workId)
    const previous = runtime.continuityRepairFailure?.fingerprint
      ? {
          fingerprint: runtime.continuityRepairFailure.fingerprint,
          count: runtime.continuityRepairFailure.escalationCount ?? 0
        }
      : undefined
    const route = routeStoryContinuityEscalation(
      chapters.map(chapter => chapter.id),
      chapterId,
      blockers,
      previous
    )
    if (route.mode === 'pause') {
      throw new GoalPhaseExhaustedError(route.hint)
    }
    const plan: RepairPlan = {
      action: route.mode === 'engine' || route.mode === 'storyline' ? 'storyline' : 'beat',
      targetChapterIds: route.targetChapterIds,
      hint: route.hint,
      issues: blockers,
      continuityEscalation: true
    }
    patchRuntimeState(workId, {
      continuityRepairFailure: {
        chapterId,
        blockers,
        attempts,
        fingerprint: route.fingerprint,
        escalationCount: route.count,
        updatedAt: new Date().toISOString()
      },
      structuralFeedback: route.hint
    })

    if (route.mode === 'contract') {
      coreSettingDAO.deleteByWorkAndTypes(workId, ['story_contract'])
      emit('连续性问题已升级到故事合同，正在自动重建合同', 'running')
      await ensureStoryContract(
        workId,
        fullConfig.goalDescription,
        route.hint,
        controller.signal,
        message => emit(message, 'running')
      )
      patchRuntimeState(workId, { repairPlan: plan })
      phase = 'repair_execute'
    } else if (route.mode === 'engine') {
      coreSettingDAO.deleteByWorkAndTypes(workId, ['story_engine', 'story_contract', 'emotion_engine'])
      patchRuntimeState(workId, { continuityPendingRepair: plan })
      phase = 'story_engine_gate'
    } else if (route.mode === 'storyline') {
      patchRuntimeState(workId, {
        repairPlan: undefined,
        continuityPendingRepair: undefined,
        forceBeatRebuild: true
      })
      phase = 'generate_beats'
    } else {
      patchRuntimeState(workId, { repairPlan: plan })
      phase = 'repair_execute'
    }

    goalRoutineDAO.appendTurn({
      work_id: workId,
      turn_no: turn,
      phase: sourcePhase,
      action: 'continuity_escalate',
      target_chapter_id: chapterId,
      summary: `连续性候选层修复未收敛，自动升级到 ${route.mode} 层（同类第 ${route.count} 次）：${route.hint}`
    })
    emit(`连续性修复未收敛，已自动升级到 ${route.mode} 层继续运行`, 'running')
    return route
  }

  appLogger.info('goal_routine', '目标循环启动', { workId, config: fullConfig })

  try {
    const pendingTitleReview = readRuntimeState(workId).titleHookCandidates
    if (pendingTitleReview && pendingTitleReview.length > 0) {
      goalRoutineDAO.setStatus(workId, 'paused')
      emit('书名与导语仍等待作者确认；未确认前不会自动采用或继续生成', 'paused')
      return
    }

    while (true) {
      if (controller.signal.aborted) {
        goalRoutineDAO.setStatus(workId, 'cancelled')
        emit('已取消', 'cancelled')
        return
      }

      if (turn >= fullConfig.maxTurns) {
        goalRoutineDAO.appendTurn({
          work_id: workId,
          turn_no: turn,
          phase,
          action: 'budget_exhausted',
          summary: `已使用 ${fullConfig.maxTurns} 轮硬预算，保存为可继续的验收检查点；尚未创建发布快照`
        })
        patchRuntimeState(workId, { terminalReason: undefined })
        goalRoutineDAO.setStatus(workId, 'paused')
        emit('目标循环已达到本轮硬预算；正文、候选和检查点均已冻结，需编辑确认后再继续', 'paused')
        return
      }

      turn++
      goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
      const attemptedPhase = phase
      // 每轮在发起模型调用前就落库。过去节拍门禁通过 continue 回到本阶段时，
      // 轮次 4/5/6 没有成功或 error 记录，界面因而只能看到 1/2/3 和实时轮次。
      goalRoutineDAO.appendTurn({
        work_id: workId,
        turn_no: turn,
        phase: attemptedPhase,
        action: 'phase_start',
        summary: `开始执行「${attemptedPhase}」阶段`
      })

      const runtimeBeforeStep = readRuntimeState(workId)
      const runtimeInput = { ...runtimeBeforeStep }
      delete runtimeInput.liveProgress
      const scopeKey = attemptedPhase === 'draft_body'
        ? `chapter:${nextEmptyBeat(workId)?.id ?? 'complete'}`
        : attemptedPhase === 'repair_execute'
          ? `repair:${runtimeBeforeStep.repairPlan?.action ?? 'unplanned'}:${(runtimeBeforeStep.repairPlan?.targetChapterIds ?? []).join(',') || 'work'}`
          : `work:${workId}`
      const stepInstance = goalRoutineDAO.beginStep({
        workId,
        stepKey: attemptedPhase,
        scopeKey,
        input: {
          phase: attemptedPhase,
          runtime: runtimeInput,
          chapters: volumeChapterDAO.listChaptersByWork(workId).map(chapter => ({
            id: chapter.id,
            status: chapter.status,
            updateTime: chapter.update_time,
            wordCount: chapter.word_count
          }))
        },
        protocolVersion: STORY_REPAIR_PROTOCOL_VERSION
      })
      setWorkflowExecutionContext({
        runId: stepInstance.run_id,
        stepInstanceId: stepInstance.id,
        workId,
        stepKey: attemptedPhase
      })
      let workflowStepFailure: ClassifiedWorkflowError | undefined

      try {
        try {
        if (phase === 'incubate_outline') {
          const count = await incubateStoryline(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'incubate', summary: `完成 ${count} 个孵化槽位`
          })
          emit(`完成 ${count} 个孵化槽位`, 'running')
          phase = 'incubator_gate'
        } else if (phase === 'incubator_gate') {
          const res = await runStorylineGate(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'gate',
            score: Math.min(res.serializabilityScore, res.conflictClosureScore),
            summary: res.repairRounds > 0
              ? `门禁通过：自动修复 ${res.repairRounds} 轮 · 可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`
              : `门禁通过：可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`
          })
          emit(res.repairRounds > 0
            ? `门禁通过：已自动修复 ${res.repairRounds} 轮 · 可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`
            : `门禁通过：可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`, 'running')
          phase = 'freeze_storyline'
        } else if (phase === 'freeze_storyline') {
          const versionId = await freezeStoryline(workId, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'freeze',
            summary: `冻结孵化版本 #${versionId}`
          })
          emit(`冻结孵化版本 #${versionId}`, 'running')
          phase = 'materialize_settings'
        } else if (phase === 'materialize_settings') {
          const count = await materializeStorySettings(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'settings', summary: `生成 ${count} 项核心设定`
          })
          emit(`生成 ${count} 项核心设定`, 'running')
          phase = 'generate_character_cards'
        } else if (phase === 'generate_character_cards') {
          emit('正在生成主角人设卡片', 'running')
          const count = await generateCharacterCards(workId, fullConfig.goalDescription, controller.signal)
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'character_cards', summary: `生成 ${count} 张主角人设卡片`
          })
          emit(`生成 ${count} 张主角人设卡片`, 'running')
          phase = 'story_engine_gate'
        } else if (phase === 'story_engine_gate') {
          const runtime = readRuntimeState(workId)
          const result = await ensureStoryEngine(
            workId,
            fullConfig.goalDescription,
            runtime.structuralFeedback ?? '',
            controller.signal,
            message => emit(message, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'engine_gate',
            score: result.score,
            summary: `故事发动机通过（${result.score}分，${result.rounds}轮）`
          })
          await ensureStoryContract(
            workId,
            fullConfig.goalDescription,
            runtime.structuralFeedback ?? '',
            controller.signal,
            message => emit(message, 'running')
          )
          phase = 'emotion_engine_gate'
        } else if (phase === 'emotion_engine_gate') {
          const result = await ensureEmotionEngine(
            workId, fullConfig.goalDescription, 'story', controller.signal,
            message => emit(message, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'emotion_engine_gate',
            score: result.score, summary: `情绪发动机通过（${result.score}分，${result.rounds}轮）`
          })
          emit(`情绪发动机通过（${result.score}分）`, 'running')
          phase = 'generate_beats'
        } else if (phase === 'generate_beats') {
          const res = await ensureBeats(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          if (res.error) throw (res.terminal ? new GoalPhaseExhaustedError(res.error) : new Error(res.error))
          if (res.recovery === 'retry_beats') {
            emit('节拍门禁未通过，保留故事发动机并在节拍层定向重建', 'running')
            phase = 'generate_beats'
            continue
          }
          if (res.recovery === 'rebuild_contract') {
            coreSettingDAO.deleteByWorkAndTypes(workId, ['story_contract'])
            emit('节拍层两次未收敛，保留故事发动机，仅重建全篇合同后继续', 'running')
            phase = 'generate_beats'
            continue
          }
          if (res.recovery === 'simplify') {
            throw new GoalPhaseExhaustedError(
              res.warning ?? '节拍合同修复预算已耗尽；已冻结当前故事发动机、节拍草稿与问题证据'
            )
          }
          if (res.recovery === 'rebuild_engine') {
            coreSettingDAO.deleteByWorkAndTypes(workId, ['story_engine', 'story_contract', 'emotion_engine'])
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'storyline',
              summary: res.warning ?? '节拍硬门禁未通过，回退故事发动机'
            })
            emit('节拍硬门禁未通过，已回退故事发动机重建', 'running')
            phase = 'story_engine_gate'
            continue
          }
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'beats',
            summary: res.warning ?? (res.created > 0 ? `生成 ${res.created} 个节拍` : '复用已有节拍')
          })
          emit(res.warning ?? (res.created > 0 ? `生成 ${res.created} 个节拍` : '复用已有节拍'), 'running')
          phase = 'generate_title_hook'
        } else if (phase === 'generate_title_hook') {
          emit('正在生成爆款书名和导语', 'running')
          const selection = await generateTitleHook(workId, fullConfig.goalDescription, controller.signal)
          if (fullConfig.humanReviewTitleHook) {
            patchRuntimeState(workId, {
              titleHookCandidates: selection.candidates,
              titleHookPreferredIndex: selection.preferredIndex
            })
            goalRoutineDAO.update(workId, {
              status: 'paused',
              current_phase: 'overall_self_check'
            })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'title_hook_review',
              summary: `已生成 ${selection.candidates.length} 组通过防剧透门禁的书名导语，等待作者确认`
            })
            emit(`已生成 ${selection.candidates.length} 组书名导语，等待作者确认；不会自动采用`, 'paused')
            return
          }
          applyTitleHook(workId, selection.preferred)
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'title_hook',
            summary: `盲评后应用书名「${selection.preferred.title}」`
          })
          emit(`已应用盲评胜出的书名「${selection.preferred.title}」和导语`, 'running')
          phase = 'overall_self_check'
        } else if (phase === 'overall_self_check') {
          emit('正在运行整体自检', 'running')
          const result = await runOverallSelfCheck(workId, controller.signal)
          const conclusionText = result.report.match(/(PASS|FAIL|REVISE|通过|不通过|需修订).{0,40}/i)?.[0] ?? '自检完成'
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'overall_check',
            score: result.conclusion?.overallScore ?? null,
            summary: conclusionText
          })
          const passed = result.conclusion != null
            && result.conclusion.blockingCount === 0
            && result.conclusion.overallScore >= PASS_SCORE_THRESHOLD
            && result.conclusion.verdict === 'pass'
          if (passed) {
            patchRuntimeState(workId, { overallRepairRounds: 0 })
            emit(`整体自检通过：${result.conclusion?.overallScore ?? '-'}分`, 'running')
            phase = 'draft_body'
          } else {
            const runtime = readRuntimeState(workId)
            const repairRound = runtime.overallRepairRounds ?? 0
            if (repairRound >= MAX_OVERALL_SETTING_REPAIR_ROUNDS) {
              throw new GoalPhaseExhaustedError(
                `核心设定整体自检经过 ${MAX_OVERALL_SETTING_REPAIR_ROUNDS} 轮定向修订仍未通过`
                + `；最后结论：${conclusionText}`
              )
            }
            const revised = await repairSettingsFromOverallCheck(
              workId,
              result.report,
              controller.signal,
              message => emit(message, 'running')
            )
            patchRuntimeState(workId, { overallRepairRounds: repairRound + 1 })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'settings_repair',
              summary: `整体自检未通过，已修订 ${revised} 项设定（第 ${repairRound + 1} 轮，达标前持续修订）`
            })
            emit(`整体自检未通过，已修订 ${revised} 项设定并重新生成依赖内容`, 'running')
            phase = 'generate_character_cards'
          }
        } else if (phase === 'draft_body') {
          const pendingRepair = readRuntimeState(workId).continuityPendingRepair
          if (pendingRepair) {
            patchRuntimeState(workId, {
              repairPlan: pendingRepair,
              continuityPendingRepair: undefined
            })
            emit('故事发动机已重建，继续执行连续性结构升级计划', 'running')
            phase = 'repair_execute'
            continue
          }
          await compensatePendingStoryMemory(workId, controller.signal)
          const beat = nextEmptyBeat(workId)
          if (!beat) {
            emit('正文已全部生成，进入目标验收', 'running')
            phase = 'goal_check'
          } else {
            emit(`正在生成正文「${beat.title}」`, 'running')
            const continuityFailure = readRuntimeState(workId).continuityRepairFailure
            const gen = await generateBeatBody(workId, beat.id, {
              signal: controller.signal,
              goalDescription: fullConfig.goalDescription,
              extraHint: continuityFailure?.chapterId === beat.id && continuityFailure.blockers.length > 0
                ? `【上一次连续性修复仍未收敛】\n${continuityFailure.blockers.map((item, i) => `${i + 1}. ${item}`).join('\n')}\n本次初稿必须从源头规避这些问题。`
                : undefined,
              onProgress: message => emit(`「${beat.title}」${message}`, 'running'),
              onContinuityEvent: event => recordContinuityEvent(beat.id, beat.title, event)
            })
            if (!gen.success && gen.requiresEscalation) {
              const blockers = gen.continuityBlockers ?? [gen.error || '连续性修复未通过']
              await escalateContinuityFailure(
                beat.id,
                blockers,
                gen.continuityRepairRounds ?? 0
              )
              continue
            }
            if (!gen.success) {
              const message = gen.error || '正文生成失败'
              throw gen.failureSignature
                ? new StoryCandidateFailureError(message, gen.failureSignature)
                : new Error(message)
            }
            if (continuityFailure?.chapterId === beat.id) {
              patchRuntimeState(workId, {
                continuityRepairFailure: undefined,
                continuityPendingRepair: undefined
              })
            }
            const mem = gen.memoryExtracted
            if (gen.memoryPending) {
              const runtime = readRuntimeState(workId)
              patchRuntimeState(workId, {
                pendingMemoryChapterIds: [...new Set([...(runtime.pendingMemoryChapterIds ?? []), beat.id])]
              })
            }
            const memMsg = gen.memoryPending
              ? ' · 记忆体：待旁路补偿（正文已安全提交）'
              : mem ? ` · 记忆体：+${mem.planted}伏笔/${mem.snapshots}快照/${mem.foreshadowingResolved}回收` : ''
            const antiAiMsg = gen.antiAiRepairs
              ? ` · 套话定点修复：${gen.antiAiRepairs}句/${gen.antiAiRepairRounds ?? 1}轮`
              : ''
            const deterministicRepairMsg = gen.deterministicRepairs
              ? ` · 无歧义原位修复：${gen.deterministicRepairs}处`
              : ''
            const continuityMsg = gen.continuityRepairRounds
              ? ` · 连续性定向修复 ${gen.continuityRepairRounds} 轮`
              : ''
            goalRoutineDAO.appendTurn({
              work_id: workId, turn_no: turn, phase, action: 'draft',
              target_chapter_id: beat.id,
              summary: `生成「${beat.title}」${gen.wordCount}字${antiAiMsg}${deterministicRepairMsg}${continuityMsg}${memMsg}`
            })
            emit(`生成「${beat.title}」${gen.wordCount}字${antiAiMsg}${continuityMsg}${memMsg}`, 'running')

            // 正文生成后可选：AI 诊断 + 修复循环，总分达标且承重项无硬伤即停
            if (fullConfig.diagnoseBodyAfterGeneration && fullConfig.qualityMin > 0) {
              const diagResult = await diagnoseAndFixUntilPass(
                workId, beat.id, fullConfig.qualityMin, controller.signal,
                msg => emit(msg, 'running')
              )
              if (diagResult.hardBlockers.length > 0) {
                goalRoutineDAO.appendTurn({
                  work_id: workId,
                  turn_no: turn,
                  phase,
                  action: 'hard_blocker_escalate',
                  target_chapter_id: beat.id,
                  summary: `逐拍硬阻塞经 ${diagResult.rounds} 轮最小修复仍未收敛：${diagResult.hardBlockers.join('；')}`
                })
                await escalateContinuityFailure(
                  beat.id,
                  diagResult.hardBlockers,
                  diagResult.rounds
                )
                continue
              }
              const cleaned = cleanupEmDashesAfterPassedGate(workId, 'comma')
              const cleanMsg = cleaned.replaced > 0 ? `；破折号已替换 ${cleaned.replaced} 处` : ''
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'diagnose_fix',
                target_chapter_id: beat.id,
                score: diagResult.finalScore >= 0 ? diagResult.finalScore : null,
                summary: `「${beat.title}」发布硬门禁通过（正文质量 ${diagResult.finalScore}分，情绪 ${diagResult.emotionScore}分，第${diagResult.bestRound}轮）`
                  + (diagResult.advisories.length > 0
                    ? `；保留非阻塞编辑建议：${diagResult.advisories.join('、')}`
                    : '')
                  + cleanMsg
              })
              emit(
                `「${beat.title}」硬门禁通过，继续后续节拍`
                + (diagResult.advisories.length > 0 ? `；${diagResult.advisories.length} 项编辑建议不阻断发布` : ''),
                'running'
              )
            } else {
              const latest = volumeChapterDAO.getChapter(beat.id)
              const emotion = await assessChapterEmotion(workId, beat.id, latest?.content ?? '', controller.signal, true)
              const emotionAccepted = isEmotionAssessmentAcceptedForTransition(emotion)
              const emotionHardBlockers = emotionAccepted ? [] : (emotion.blocking_issues ?? [])
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'emotion_check',
                target_chapter_id: beat.id,
                score: emotion.score,
                summary: emotionHardBlockers.length === 0
                  ? `「${beat.title}」情绪因果硬门禁通过（${emotion.score}分）`
                    + (!emotionAccepted ? '；低分仅保留为编辑建议' : '')
                  : `「${beat.title}」情绪因果存在 ${emotionHardBlockers.length} 项证据阻塞：${emotionHardBlockers.join('；')}`
              })
              if (emotionHardBlockers.length > 0) {
                await escalateContinuityFailure(beat.id, emotionHardBlockers, 1)
                continue
              }
              if (!emotionAccepted) {
                emit(`「${beat.title}」情绪盲读 ${emotion.score} 分，未发现证据化硬阻塞，作为编辑建议继续`, 'running')
              }
            }

            phase = nextEmptyBeat(workId) ? 'draft_body' : 'goal_check'
          }
        } else if (phase === 'goal_check') {
          emit('正在进行目标验收（质量/字数/门禁/目标匹配）', 'running')
          if (!getStoryContract(workId)) {
            emit('现有故事合同缺少制度规则或高潮证据链，正在升级后再终审', 'running')
            await ensureStoryContract(
              workId,
              fullConfig.goalDescription,
              '旧合同缺少 rule_proofs 或 climax_evidence_chain。必须依据现有正文事实重建可执行合同；不得为迁就正文中的巧合而伪造因果。',
              controller.signal,
              message => emit(message, 'running')
            )
          }
          const povFreeze = ensureFrozenStoryPovModes(workId)
          if (povFreeze && povFreeze.updated > 0) {
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'freeze_pov',
              summary: `旧故事缺少视角元数据，已按首拍正文冻结 ${povFreeze.updated} 个节拍为 ${povFreeze.mode}`
            })
          }
          lastCheck = await runGoalCheckWithVisibleProgress()
          patchRuntimeState(workId, { lastCheck })
          goalRoutineDAO.update(workId, {
            last_quality_score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : null,
            goal_met: lastCheck.met
          })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'check',
            score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : lastCheck.goalMatchScore,
            summary: lastCheck.met
              ? (lastCheck.advisories.length > 0
                  ? `发布硬门禁通过，保留 ${lastCheck.advisories.length} 项非阻塞编辑建议`
                  : '目标达成')
              : lastCheck.reasons.join('；')
          })
          if (lastCheck.evaluatorFailure) {
            goalRoutineDAO.update(workId, {
              status: 'paused',
              current_phase: 'goal_check',
              goal_met: false
            })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'evaluator_pause',
              summary: `${lastCheck.evaluatorFailure.code}：${lastCheck.evaluatorFailure.message}；正文、候选与发布状态均未改写`
            })
            emit(
              `评估器证据不可用，已冻结当前正文并暂停；不会把评估故障当作质量失败重写：${lastCheck.evaluatorFailure.message}`,
              'paused'
            )
            return
          }

          const runtime = readRuntimeState(workId)
          const capability = resolveStoryModelCapability(getGoalLoopModelOpts(workId))
          const wholeAuditCount = (runtime.wholeAuditCount ?? 0) + 1
          const composite = goalCheckComposite(lastCheck)
          const signature = goalCheckSignature(lastCheck)
          const noMeaningfulGain = runtime.lastCheckComposite != null
            && composite <= runtime.lastCheckComposite + 1
            && signature === runtime.lastCheckSignature
          const stagnantChecks = noMeaningfulGain ? (runtime.stagnantChecks ?? 0) + 1 : 0
          const evaluationHistory = [
            ...(runtime.evaluationHistory ?? []),
            {
              checkedAt: new Date().toISOString(),
              qualityScore: lastCheck.qualityScore,
              goalMatchScore: lastCheck.goalMatchScore,
              overallStoryScore: lastCheck.overallStoryScore,
              previewHookScore: lastCheck.previewHookScore,
              proseReadScore: lastCheck.proseReadScore,
              composite,
              weakestLayer: lastCheck.weakestLayer,
              issues: lastCheck.storyIssues.slice(0, 10)
            }
          ].slice(-20)
          patchRuntimeState(workId, {
            lastCheckComposite: composite,
            lastCheckSignature: signature,
            stagnantChecks,
            wholeAuditCount,
            evaluationHistory
          })

          if (lastCheck.met) {
            const unresolvedLedger = storyHarnessDAO.listIssues(workId)
              .filter(issue => issue.status === 'open' || issue.status === 'stalled')
            if (unresolvedLedger.length > 0) {
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'ledger_confirmation',
                summary: `当前终审已无对应硬伤，但问题账本仍有 ${unresolvedLedger.length} 项等待第二次同稿独立复核`
              })
              emit(`问题账本仍有 ${unresolvedLedger.length} 项等待第二次同稿独立复核，暂不创建发布快照`, 'running')
              phase = 'goal_check'
              continue
            }
            const cleanup = cleanupEmDashesAfterPassedGate(workId, 'comma')
            if (cleanup.replaced > 0) {
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'deai',
                summary: `门禁通过后自动替换破折号：${cleanup.chapters} 个节拍 ${cleanup.replaced} 处`
              })
              emit(`门禁通过后已自动替换破折号：${cleanup.chapters} 个节拍 ${cleanup.replaced} 处`, 'running')
              lastCheck = await runGoalCheckWithVisibleProgress()
              patchRuntimeState(workId, { lastCheck })
              goalRoutineDAO.update(workId, {
                last_quality_score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : null,
                goal_met: lastCheck.met
              })
              if (lastCheck.evaluatorFailure) {
                goalRoutineDAO.update(workId, {
                  status: 'paused',
                  current_phase: 'goal_check',
                  goal_met: false
                })
                goalRoutineDAO.appendTurn({
                  work_id: workId,
                  turn_no: turn,
                  phase,
                  action: 'evaluator_pause',
                  summary: `${lastCheck.evaluatorFailure.code}：${lastCheck.evaluatorFailure.message}；清理后的正文已冻结`
                })
                emit('清理后评估器证据不可用，已冻结正文并暂停；不会进入修复', 'paused')
                return
              }
              if (!lastCheck.met) {
                emit(`清理后复验未通过：${lastCheck.reasons.join('；')}`, 'running')
                phase = 'repair_plan'
                continue
              }
              const unresolvedAfterCleanup = storyHarnessDAO.listIssues(workId)
                .filter(issue => issue.status === 'open' || issue.status === 'stalled')
              if (unresolvedAfterCleanup.length > 0) {
                emit(`清理后问题账本有 ${unresolvedAfterCleanup.length} 项等待同稿复核，暂不创建发布快照`, 'running')
                phase = 'goal_check'
                continue
              }
            }

            if (!lastCheck.releasePromise || !lastCheck.compliance) {
              throw new GoalPhaseExhaustedError('发布兑现或平台合规证据缺失，已冻结当前正文，禁止创建发布快照')
            }
            const snapshotId = storyHarnessDAO.createReleaseSnapshot(workId, {
              promise: lastCheck.releasePromise,
              compliance: lastCheck.compliance,
              sourceHash: lastCheck.releaseSourceHash
            })
            if (lastCheck.advisories.length > 0) {
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'release_advisory',
                summary: `发布快照保留编辑建议：${lastCheck.advisories.join('；')}`
              })
            }
            patchRuntimeState(workId, { terminalReason: undefined })
            goalRoutineDAO.setStatus(workId, 'goal_met')

            // 试读卡点报告
            const previewRatioPct = Math.round(fullConfig.previewRatio * 100)
            if (lastCheck.previewReport) {
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'preview_anchor',
                summary: `试读卡点报告（目标比例 ${previewRatioPct}%）已生成`
              })
            }
            emit(`目标达成并冻结发布快照 #${snapshotId}：质量${lastCheck.qualityScore} · 情绪盲读${lastCheck.emotionScore} · 整篇${lastCheck.overallStoryScore} · 原文盲读${lastCheck.proseReadScore} · 试读追读力${lastCheck.previewHookScore} · 目标匹配${lastCheck.goalMatchScore} · 节拍${lastCheck.contentBeats}/${lastCheck.totalBeats} · 字数${lastCheck.totalWords} · 试读${previewRatioPct}%`, 'goal_met')
            return
          }

          if ((lastCheck.storyHardBlockers?.length ?? 0) > 0) {
            const feedback = lastCheck.storyHardBlockers.join('；')
            const chapters = volumeChapterDAO.listChaptersByWork(workId)
            if (!lastCheck.forensicIssues?.length) {
              goalRoutineDAO.setStatus(workId, 'paused')
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'evaluator_pause',
                summary: '整篇硬阻塞缺少结构化法医证据，已冻结正文并暂停'
              })
              emit('整篇硬阻塞缺少结构化法医证据，已冻结正文并暂停；不会生成兼容性修复计划', 'paused')
              return
            }
            const issues: StoryForensicIssue[] = lastCheck.forensicIssues
            const firstRoute = routeStoryForensicRepair(chapters, issues, 1)
            const previousForensic = runtime.forensicRepairStall
            const forensicCount = previousForensic?.fingerprint === firstRoute.fingerprint
              ? previousForensic.count + 1 : 1
            const route = routeStoryForensicRepair(chapters, issues, forensicCount)
            patchRuntimeState(workId, {
              forensicRepairStall: { fingerprint: route.fingerprint, count: forensicCount },
              stagnantChecks: 0,
              lastCheckComposite: undefined,
              lastCheckSignature: undefined
            })

            if (route.mode === 'retry_audit') {
              if (issues.some(issue => issue.code === 'FORENSIC_EVALUATOR_ERROR')) {
                goalRoutineDAO.appendTurn({
                  work_id: workId, turn_no: turn, phase, action: 'evaluator_pause',
                  summary: '法医评估器证据协议无效，冻结全部原文与候选并暂停'
                })
                goalRoutineDAO.setStatus(workId, 'paused')
                emit('法医评估器证据协议无效，已冻结全部原文与候选并暂停；不会触发正文改写', 'paused')
                return
              }
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'check',
                summary: `法医全局硬伤首次告警，保留原文并进行第 ${forensicCount + 1} 次独立复核：${feedback}`
              })
              emit('法医审计需要独立复核，已保留全部原文', 'running')
              phase = 'goal_check'
              continue
            }

            if (route.mode === 'reset_beats' || route.mode === 'reset_engine') {
              const returnToEngine = route.mode === 'reset_engine'
              if (returnToEngine) {
                coreSettingDAO.deleteByWorkAndTypes(workId, ['story_engine', 'story_contract', 'emotion_engine'])
              }
              patchRuntimeState(workId, {
                structuralFeedback: route.hint,
                forceBeatRebuild: true,
                repairPlan: undefined,
                wholeAuditCount: 0
              })
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase,
                action: returnToEngine ? 'storyline' : 'beat',
                summary: `同一法医证据连续 ${forensicCount} 轮未消除，已保留旧正文版本并回退到${returnToEngine ? '故事发动机' : '整组节拍'}重建`
              })
              emit(`法医动态修复未收敛，旧正文已入版本历史，正在升级到${returnToEngine ? '故事发动机' : '整组节拍'}重建`, 'running')
              phase = returnToEngine ? 'story_engine_gate' : 'generate_beats'
              continue
            }

            const plan: RepairPlan = {
              action: route.action,
              targetChapterIds: route.targetChapterIds,
              targetWordCounts: Object.fromEntries(route.targetChapterIds.map(id => {
                const chapter = volumeChapterDAO.getChapter(id)
                return [id, Math.max(600, chapter?.word_count ?? 0)]
              })),
              hint: route.hint,
              issues: issues.map(issue => `${issue.code}：${issue.message}`),
              forensicIssues: issues,
              forensicFingerprint: route.fingerprint,
              targetLead: route.targetLead,
              issueKeys: route.issueKeys
            }
            patchRuntimeState(workId, { repairPlan: plan, wholeAuditCount: 0 })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: route.action,
              target_chapter_id: route.targetChapterIds[0] ?? null,
              summary: `整篇法医审计阻止交付，保留原文并执行第 ${forensicCount} 轮动态修复：${route.hint}`
            })
            emit(`法医审计发现硬伤，正在动态修复 ${route.targetChapterIds.length} 个节拍，其他原文保留`, 'running')
            phase = 'repair_execute'
            continue
          }

          // 已确认的硬伤必须先进入定向修复。审计预算只限制没有硬伤路由可执行的
          // 重复评分，不能在“第二次复核确认硬伤”这一刻抢先暂停整个循环。
          if (wholeAuditCount >= capability.maxWholeAudits) {
            patchRuntimeState(workId, { terminalReason: undefined })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'audit_budget_exhausted',
              summary: `整篇审计已达到 ${capability.maxWholeAudits} 次上限，保存为可继续的验收检查点：${lastCheck.reasons.join('；')}`
            })
            goalRoutineDAO.setStatus(workId, 'paused')
            emit(`整篇审计已达到 ${capability.maxWholeAudits} 次上限，尚未生成发布快照；正文、候选和问题账本已冻结，需编辑确认后再继续`, 'paused')
            return
          }

          if (runtime.forensicRepairStall) patchRuntimeState(workId, { forensicRepairStall: undefined })

          if (stagnantChecks >= MAX_STAGNANT_CHECKS) {
            const resetCount = runtime.structuralResetCount ?? 0
            const feedback = [lastCheck.reasons.join('；'), ...lastCheck.storyIssues].filter(Boolean).join('；')
            const returnToEngine = lastCheck.weakestLayer === 'storyline'
            if (returnToEngine) coreSettingDAO.deleteByWorkAndTypes(workId, ['story_engine', 'story_contract', 'emotion_engine'])
            patchRuntimeState(workId, {
              structuralResetCount: resetCount + 1,
              structuralFeedback: feedback,
              forceBeatRebuild: true,
              stagnantChecks: 0,
              lastCheckComposite: undefined,
              lastCheckSignature: undefined
            })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: returnToEngine ? 'storyline' : 'beat',
              summary: `连续 ${stagnantChecks} 次无提升，第 ${resetCount + 1} 次保留旧正文版本并回退到${returnToEngine ? '故事发动机' : '整组节拍'}重生`
            })
            emit(`连续 ${stagnantChecks} 次无提升，已回退到${returnToEngine ? '故事发动机' : '整组节拍'}继续重生`, 'running')
            phase = returnToEngine ? 'story_engine_gate' : 'generate_beats'
            continue
          }

          emit(`未达标：${lastCheck.reasons.join('；')}`, 'running')
          phase = 'repair_plan'
        } else if (phase === 'repair_plan') {
          const plan = buildRepairPlan(workId, lastCheck)
          patchRuntimeState(workId, { repairPlan: plan })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: plan.action,
            target_chapter_id: plan.targetChapterIds[0] ?? null,
            summary: `修复计划：${plan.action} · ${plan.hint}`
          })
          emit(`修复计划：${plan.action}`, 'running')
          phase = 'repair_execute'
        } else if (phase === 'repair_execute') {
          const row = goalRoutineDAO.getByWork(workId)
          const parsed = row?.state_json ? JSON.parse(row.state_json) as { repairPlan?: RepairPlan } : {}
          const plan = parsed.repairPlan ?? buildRepairPlan(workId, lastCheck)
          const capability = resolveStoryModelCapability(getGoalLoopModelOpts(workId))
          const relevantLedgerIssues = filterStoryRepairLedgerIssues(
            storyHarnessDAO.listIssues(workId),
            plan.issueKeys ?? []
          )
          emit(`正在执行修复：${plan.action}`, 'running')
          let execution: Awaited<ReturnType<typeof executeRepairPlan>>
            = await applyDeterministicSentenceRepair(plan, controller.signal)
          if (!execution.changed) {
            const stalledIssue = relevantLedgerIssues.find(issue => issue.status === 'stalled')
            if (stalledIssue) {
              const currentRuntime = readRuntimeState(workId)
              const fingerprint = plan.forensicFingerprint
                ?? currentRuntime.forensicRepairStall?.fingerprint
                ?? `${stalledIssue.issue_key}:stalled`
              patchRuntimeState(workId, {
                terminalReason: undefined,
                repairPlan: undefined,
                structuralFeedback: [
                  `问题 ${stalledIssue.code} 的局部修复预算已耗尽，必须升级为整组节拍重建。`,
                  plan.hint
                ].filter(Boolean).join('\n'),
                forceBeatRebuild: true,
                forensicRepairStall: {
                  fingerprint,
                  count: stalledStoryForensicEscalationCount(currentRuntime.forensicRepairStall?.count)
                }
              })
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'issue_escalated',
                target_chapter_id: plan.targetChapterIds[0] ?? null,
                summary: `${stalledIssue.code} 已达到 ${stalledIssue.attempts} 次局部修复上限；保留旧正文版本并升级整组节拍重建`
              })
              emit(`问题 ${stalledIssue.code} 的局部修复未收敛，已保留旧正文并自动升级整组节拍重建`, 'running')
              phase = 'generate_beats'
              continue
            }
            execution = await executeRepairPlan(
              workId,
              plan,
              fullConfig.goalDescription,
              controller.signal,
              (chapterId, event) => {
                const chapter = volumeChapterDAO.getChapter(chapterId)
                recordContinuityEvent(chapterId, chapter?.title ?? String(chapterId), event)
              }
            )
          }
          if (execution.continuityFailure) {
            await escalateContinuityFailure(
              execution.continuityFailure.chapterId,
              execution.continuityFailure.blockers,
              execution.continuityFailure.attempts
            )
            continue
          }
          if (execution.changed) {
            for (const issue of relevantLedgerIssues.filter(issue => issue.status === 'open')) {
              storyHarnessDAO.incrementIssueAttempt(
                workId,
                issue.issue_key,
                capability.maxIssueRepairs
              )
            }
          }
          const summary = execution.summary
          // 新正文/新结构必须获得一套新的整篇审计预算；旧稿的两次复核不能
          // 把修复后的候选直接判成“预算耗尽”。总轮次与问题尝试上限仍负责熔断。
          patchRuntimeState(workId, {
            wholeAuditCount: 0,
            terminalReason: execution.changed ? undefined : readRuntimeState(workId).terminalReason
          })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: plan.action,
            target_chapter_id: plan.targetChapterIds[0] ?? null,
            summary
          })
          emit(`执行修复：${summary}`, 'running')
          if (plan.continuityEscalation) {
            patchRuntimeState(workId, {
              continuityRepairFailure: undefined,
              continuityPendingRepair: undefined
            })
          }
          phase = 'goal_check'
        }
        if (readRuntimeState(workId).executionFailure) {
          patchRuntimeState(workId, { executionFailure: undefined })
        }
        } catch (e) {
        const protocolAttemptNo = goalRoutineDAO.getProtocolStepAttemptCount(stepInstance)
        workflowStepFailure = classifyWorkflowError(e, protocolAttemptNo)
        goalRoutineDAO.failStep(stepInstance.id, {
          errorClass: workflowStepFailure.errorClass,
          errorCode: workflowStepFailure.code,
          message: workflowStepFailure.message
        })
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
        if (
          workflowStepFailure.errorClass === 'transient_transport'
          || workflowStepFailure.errorClass === 'provider_rate_limit'
        ) {
          turn = Math.max(0, turn - 1)
          goalRoutineDAO.update(workId, { turn_count: turn, status: 'running' })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'transport_retry',
            summary: `${workflowStepFailure.code}：${msg}；${workflowStepFailure.retryDelayMs}ms 后自动恢复，不消耗内容轮次`
          })
          emit(`模型服务暂时不可用，${Math.ceil(workflowStepFailure.retryDelayMs / 1000)} 秒后自动恢复`, 'running')
          await waitForWorkflowRetry(workflowStepFailure.retryDelayMs, controller.signal)
          continue
        }
        if (
          workflowStepFailure.errorClass === 'response_protocol'
          && protocolAttemptNo <= 2
        ) {
          turn = Math.max(0, turn - 1)
          goalRoutineDAO.update(workId, { turn_count: turn, status: 'running' })
          emit('结构化响应协议未通过，正在对当前步骤进行一次定点协议修复', 'running')
          continue
        }
        if (workflowStepFailure.code === 'BOUNDARY_ATOMIC_MISMATCH') {
          patchRuntimeState(workId, {
            repairPlan: undefined,
            executionFailure: undefined,
            forceBeatRebuild: true,
            structuralFeedback: [
              '相邻节拍边界必须作为 boundary_pair 原子重建，禁止再次执行同一正文修复。',
              msg
            ].join('\n')
          })
          phase = 'generate_beats'
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'deterministic_replan',
            summary: '边界原子性冲突已路由到整组节拍边界重建；不会重试原 repair_execute'
          })
          emit('检测到确定性边界冲突，已自动转向整组节拍边界重建', 'running')
          continue
        }
        const previousFailure = readRuntimeState(workId).executionFailure
        const signature = routineFailureSignature(attemptedPhase, e)
        const failureCount = previousFailure?.phase === attemptedPhase && previousFailure.signature === signature
          ? previousFailure.count + 1
          : 1
        patchRuntimeState(workId, {
          executionFailure: {
            phase: attemptedPhase,
            signature,
            count: failureCount,
            message: msg,
            updatedAt: new Date().toISOString()
          }
        })
        const phaseBudgetExhausted = e instanceof GoalPhaseExhaustedError
        if (phaseBudgetExhausted || failureCount >= STORY_ROUTINE_FAILURE_LIMIT) {
          goalRoutineDAO.setStatus(workId, 'paused')
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'failure_pause',
            summary: phaseBudgetExhausted
              ? `「${attemptedPhase}」阶段内部修复预算已耗尽，目标循环安全暂停：${msg}`
              : `「${attemptedPhase}」连续 ${failureCount} 次发生同类异常，目标循环已自动暂停：${msg}`
          })
          emit(
            phaseBudgetExhausted
              ? `「${attemptedPhase}」阶段内部修复预算已耗尽，已安全暂停：${msg}`
              : `「${attemptedPhase}」连续 ${failureCount} 次发生同类异常，已自动暂停：${msg}`,
            'paused'
          )
          return
        }
        emit(`轮次异常：${msg}`, 'running')
        emit(`「${attemptedPhase}」第 ${failureCount} 次发生同类异常，将有限重试；连续 ${STORY_ROUTINE_FAILURE_LIMIT} 次后自动暂停`, 'running')
        }
      } finally {
        if (!workflowStepFailure) {
          goalRoutineDAO.completeStep(stepInstance.id, phase, {
            turn,
            nextPhase: phase,
            runStatus: goalRoutineDAO.getByWork(workId)?.status
          })
        }
        clearWorkflowExecutionContext(workId, stepInstance.id)
      }
    }

  } finally {
    clearGoalLoopModelOpts(workId)
    activeLoops.delete(workId)
  }
}
