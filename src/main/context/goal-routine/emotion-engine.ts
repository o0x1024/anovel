import { coreSettingDAO, emotionalStateDAO, volumeChapterDAO, workDAO } from '../../db'
import { modelService } from '../../model'
import {
  type EmotionContract,
  type EmotionEngine,
  formatEmotionContractForPrompt,
  normalizeEmotionContract
} from '../../../shared/emotion-contract'
import { extractJsonText } from '../parse-json-extract'
import { withGoalLoopModelOptions } from './story-goal-model'

const EMOTION_ENGINE_MAX_ROUNDS = 4
const EMOTION_CONTRACT_MAX_ROUNDS = 3

const EMOTION_CONTRACT_JSON_SHAPE = {
  pov_character: '视角人物',
  attachment_anchor: '本章开始前读者已经能感知的具体依恋依据',
  value_at_stake: '正在被威胁或兑现的关系/身份/价值',
  reader_state_before: { label: '进入情绪', valence: 0, arousal: 1, agency: 0, certainty: 2 },
  trigger_event: '触发重新评价的事件',
  character_appraisal: {
    perceived_meaning: '人物主观认为这意味着什么',
    blame_or_cause: '责任归因', controllability: '控制感', certainty: '确定性', value_or_norm_violated: '触碰的价值或规范'
  },
  character_layers: {
    felt: '真实复合情绪', admitted: '愿意承认的部分', displayed: '对外表现', suppressed: '隐藏或压抑', action_impulse: '行动冲动'
  },
  information_position: {
    reader_knows: '读者已知/怀疑', pov_knows: '视角人物已知/误信', other_knows: '他人已知', gap_type: 'reader_ahead'
  },
  choice_and_cost: '情绪迫使人物做出的选择及代价',
  private_detail_anchor: '只属于该人物/关系的物件、习惯或记忆',
  subtext_or_omission: '对白表层之下争夺什么，或必须留白什么',
  reader_state_after: { label: '离场情绪', valence: -1, arousal: 3, agency: -1, certainty: 1 },
  arc_role: 'build',
  emotional_debt_opened: '新增情绪债或空字符串',
  emotional_debt_paid: '兑现的情绪债或空字符串',
  residue_into_next: '下一章仍会改变注意、语言、关系或选择的余波'
}

function parseObject(content: string, label: string): Record<string, unknown> {
  const raw = extractJsonText(content.trim()) ?? content.trim()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('根节点必须是对象')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`${label}解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map(item => item.trim()).filter(Boolean) : []
}

function normalizeEmotionEngine(value: unknown): EmotionEngine | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const promise = row.emotional_promise as Record<string, unknown> | undefined
  const conflict = row.core_inner_conflict as Record<string, unknown> | undefined
  const attachments = Array.isArray(row.attachment_contracts) ? row.attachment_contracts : []
  if (!promise || !conflict || attachments.length === 0) return null
  const engine: EmotionEngine = {
    target_reader: stringValue(row.target_reader),
    emotional_promise: {
      primary: stringValue(promise.primary),
      counter_emotion: stringValue(promise.counter_emotion),
      catharsis: stringValue(promise.catharsis),
      aftertaste: stringValue(promise.aftertaste)
    },
    core_emotional_question: stringValue(row.core_emotional_question),
    attachment_contracts: attachments.map(item => {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return {
        subject: stringValue(entry.subject), valued_object: stringValue(entry.valued_object),
        why_reader_cares: stringValue(entry.why_reader_cares), vulnerability: stringValue(entry.vulnerability),
        admiration_evidence: stringValue(entry.admiration_evidence), contradiction: stringValue(entry.contradiction),
        credible_loss: stringValue(entry.credible_loss)
      }
    }).filter(item => item.subject && item.valued_object && item.why_reader_cares),
    core_inner_conflict: {
      wanted: stringValue(conflict.wanted), needed: stringValue(conflict.needed),
      feared_truth: stringValue(conflict.feared_truth), protective_lie: stringValue(conflict.protective_lie)
    },
    arc_principles: stringList(row.arc_principles),
    recurring_anchors: stringList(row.recurring_anchors)
  }
  const required = [engine.target_reader, engine.emotional_promise.primary, engine.emotional_promise.catharsis,
    engine.core_emotional_question, engine.core_inner_conflict.wanted, engine.core_inner_conflict.feared_truth]
  return required.every(Boolean) && engine.attachment_contracts.length > 0 ? engine : null
}

function sourceContext(workId: number): string {
  const work = workDAO.getById(workId)
  const settings = coreSettingDAO.listByWork(workId)
    .filter(setting => [
      'idea', 'protagonist', 'golden_finger', 'world_pressure', 'conflict_engine',
      'pleasure_engine', 'supporting_cast', 'main_plotline', 'story_engine'
    ].includes(setting.type))
    .map(setting => `## ${setting.type}\n${setting.content}`)
    .join('\n\n')
  return [`作品：${work?.title ?? '未命名'}`, `题材：${work?.genre ?? ''}`, `标签：${work?.tags ?? ''}`, settings].join('\n')
}

export function loadEmotionEngine(workId: number): EmotionEngine | null {
  const setting = coreSettingDAO.getByType(workId, 'emotion_engine')
  const sources = [setting?.structured_content, setting?.content]
  for (const source of sources) {
    if (!source?.trim()) continue
    try {
      const parsed = JSON.parse(extractJsonText(source) ?? source) as unknown
      const engine = normalizeEmotionEngine(parsed)
      if (engine) return engine
    } catch { /* 尝试下一来源 */ }
  }
  return null
}

export async function ensureEmotionEngine(
  workId: number,
  goal: string,
  workType: 'story' | 'novel',
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ score: number; rounds: number }> {
  const existing = loadEmotionEngine(workId)
  if (existing) return { score: 100, rounds: 0 }
  const source = sourceContext(workId)
  if (!source.trim()) throw new Error('情绪发动机缺少人物与故事设定')
  let feedback = ''
  for (let round = 1; round <= EMOTION_ENGINE_MAX_ROUNDS; round++) {
    if (signal?.aborted) throw new Error('已取消')
    onProgress?.(`正在运行情绪发动机门禁（第 ${round}/${EMOTION_ENGINE_MAX_ROUNDS} 轮）`)
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId, step: 'emotion_engine_gate', enrichWorkContext: false, enrichNarrativeMemory: false,
        temperature: 0.15, maxTokens: 3000,
        systemPrompt: [
          '你是小说情绪因果主编。设计的不是情绪词和刺激强度，而是读者为何在乎、人物如何评价事件、选择如何付出代价、情绪如何积累与兑现。',
          `作品类型：${workType === 'story' ? '短故事' : '长篇小说'}。短故事快速建立具体依恋；长篇必须支持跨卷关系积累、回调和余波。`,
          '必须区分角色情绪、角色外显、叙述策略和读者情绪。低唤醒场景必须承担依恋、预感、亲密或余味功能。',
          '只输出 JSON：{"passed":false,"score":0,"blocking_issues":[],"engine":{"target_reader":"","emotional_promise":{"primary":"","counter_emotion":"","catharsis":"","aftertaste":""},"core_emotional_question":"","attachment_contracts":[{"subject":"","valued_object":"","why_reader_cares":"","vulnerability":"","admiration_evidence":"","contradiction":"","credible_loss":""}],"core_inner_conflict":{"wanted":"","needed":"","feared_truth":"","protective_lie":""},"arc_principles":[],"recurring_anchors":[]}}',
          '通过条件：至少一个可观察的依恋合同；核心情绪问题不可用单次反转轻易解决；宣泄由人物选择和代价挣得；存在反情绪、恢复段和结局余味；不得使用“极致情绪、情绪拉满”等空话。',
          'score 低于85或有 blocking_issues 时 passed=false。'
        ].join('\n\n'),
        prompt: [`【创作目标】${goal.trim() || '让读者持续在乎人物与结果'}`, `【作品设定】\n${source}`, feedback].filter(Boolean).join('\n\n')
      }), { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) throw new Error(response.error || '情绪发动机无返回')
    const parsed = parseObject(response.content, '情绪发动机')
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)))
    const blockers = stringList(parsed.blocking_issues)
    const engine = normalizeEmotionEngine(parsed.engine)
    if (parsed.passed === true && score >= 85 && blockers.length === 0 && engine) {
      coreSettingDAO.upsertStructured(
        workId, 'emotion_engine',
        `# 情绪发动机\n\n${JSON.stringify(engine, null, 2)}`,
        JSON.stringify(engine)
      )
      return { score, rounds: round }
    }
    feedback = `【上一轮阻塞，必须重建】\n${JSON.stringify({ score, blockers, engine: parsed.engine }, null, 2)}`
  }
  throw new Error(`情绪发动机 ${EMOTION_ENGINE_MAX_ROUNDS} 轮仍未通过`)
}

export function loadChapterEmotionContract(chapterId: number): EmotionContract | null {
  const chapter = volumeChapterDAO.getChapter(chapterId)
  const sources: unknown[] = []
  if (chapter?.emotion_contract_json) sources.push(chapter.emotion_contract_json)
  if (chapter?.outline_diagnosis) {
    try { sources.push((JSON.parse(chapter.outline_diagnosis) as Record<string, unknown>).emotion_contract) } catch { /* 无效旧数据 */ }
  }
  for (const source of sources) {
    try {
      const parsed = typeof source === 'string' ? JSON.parse(source) as unknown : source
      const contract = normalizeEmotionContract(parsed)
      if (contract) return contract
    } catch { /* 尝试下一来源 */ }
  }
  return null
}

function emotionalContinuity(workId: number): string {
  const rows = emotionalStateDAO.latestForWork(workId, 10)
  if (rows.length === 0) return '尚无前章情绪账本，这是开篇或首次生成。'
  return rows.map(row => [
    `角色:${row.character_name}`, `真实:${row.felt_state}`, `外显:${row.displayed_state}`,
    `未解:${row.unresolved_emotion}`, `防御:${row.protective_strategy}`, `后效:${row.behavioral_aftereffect}`
  ].join(' | ')).join('\n')
}

export async function ensureChapterEmotionContract(
  workId: number,
  chapterId: number,
  goal = '',
  signal?: AbortSignal
): Promise<EmotionContract> {
  const existing = loadChapterEmotionContract(chapterId)
  if (existing) return existing
  const work = workDAO.getById(workId)
  let engine = loadEmotionEngine(workId)
  if (!engine) {
    await ensureEmotionEngine(workId, goal, work?.work_type === 'story' ? 'story' : 'novel', signal)
    engine = loadEmotionEngine(workId)
  }
  if (!engine) throw new Error('情绪发动机未生成')
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const index = chapters.findIndex(chapter => chapter.id === chapterId)
  const chapter = chapters[index]
  if (!chapter) throw new Error('章节不存在')
  const neighborhood = chapters.slice(Math.max(0, index - 2), Math.min(chapters.length, index + 3))
    .map(item => ({ title: item.title, outline: item.outline, emotion_contract: item.emotion_contract_json }))
  let feedback = ''
  for (let round = 1; round <= EMOTION_CONTRACT_MAX_ROUNDS; round++) {
    if (signal?.aborted) throw new Error('已取消')
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId, chapterId, step: 'emotion_contract_generate', enrichWorkContext: false, enrichNarrativeMemory: false,
        temperature: 0.15, maxTokens: 2300,
        systemPrompt: [
          '你是场景情绪因果设计师。根据情节合同与跨章状态，为当前章生成可执行 emotion_contract。',
          '情绪必须来自“关切→触发→人物主观评价→表里冲突→有代价选择→读者推断→余波”，不能用情绪词浓度代替。',
          'reader_state_before/after 的 valence -2..2，arousal 0..4，agency -2..2，certainty 0..4。',
          'gap_type 只能是 reader_ahead/reader_equal/reader_behind；arc_role 只能是 attach/build/hold/break/release/aftertaste。',
          `只输出 JSON：${JSON.stringify(EMOTION_CONTRACT_JSON_SHAPE)}`
        ].join('\n\n'),
        prompt: [
          `【情绪发动机】\n${JSON.stringify(engine, null, 2)}`,
          `【创作目标】${goal.trim() || '人物情绪可信且驱动选择'}`,
          `【当前章】${chapter.title}\n${chapter.outline ?? ''}\n${chapter.outline_diagnosis ?? ''}`,
          `【相邻章节】\n${JSON.stringify(neighborhood, null, 2)}`,
          `【跨章情绪账本】\n${emotionalContinuity(workId)}`,
          feedback
        ].filter(Boolean).join('\n\n')
      }), { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) throw new Error(response.error || '情绪契约生成无返回')
    let contract: EmotionContract | null = null
    try { contract = normalizeEmotionContract(parseObject(response.content, '情绪契约')) } catch { contract = null }
    if (contract) {
      volumeChapterDAO.updateChapter(chapterId, { emotion_contract_json: JSON.stringify(contract), emotion_assessment_json: null })
      return contract
    }
    feedback = '【上一轮无效】字段缺失或枚举非法，必须按完整 JSON 结构重写，不得省略。'
  }
  throw new Error(`情绪契约 ${EMOTION_CONTRACT_MAX_ROUNDS} 轮仍无效`)
}

export function emotionExecutionCard(chapterId: number): string {
  const contract = loadChapterEmotionContract(chapterId)
  return contract ? formatEmotionContractForPrompt(contract) : ''
}

export { EMOTION_CONTRACT_JSON_SHAPE }
