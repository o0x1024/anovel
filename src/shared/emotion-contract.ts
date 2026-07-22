export type EmotionArcRole = 'attach' | 'build' | 'hold' | 'break' | 'release' | 'aftertaste'

export const EMOTION_ARC_ROLES: readonly EmotionArcRole[] = [
  'attach', 'build', 'hold', 'break', 'release', 'aftertaste'
]

export const EMOTION_GAP_TYPES = ['reader_ahead', 'reader_equal', 'reader_behind'] as const

/** 提示词与解析器共用的枚举约束，避免模型输出规则与代码校验规则漂移。 */
export const EMOTION_CONTRACT_ENUM_RULE = [
  `arc_role 只能是 ${EMOTION_ARC_ROLES.join('/')}`,
  `gap_type 只能是 ${EMOTION_GAP_TYPES.join('/')}`,
  'reader_state_before/after：valence -2..2，arousal 0..4，agency -2..2，certainty 0..4'
].join('；')

export interface EmotionStateVector {
  label: string
  valence: number
  arousal: number
  agency: number
  certainty: number
}

export interface EmotionContract {
  pov_character: string
  attachment_anchor: string
  value_at_stake: string
  reader_state_before: EmotionStateVector
  trigger_event: string
  character_appraisal: {
    perceived_meaning: string
    blame_or_cause: string
    controllability: string
    certainty: string
    value_or_norm_violated: string
  }
  character_layers: {
    felt: string
    admitted: string
    displayed: string
    suppressed: string
    action_impulse: string
  }
  information_position: {
    reader_knows: string
    pov_knows: string
    other_knows: string
    gap_type: 'reader_ahead' | 'reader_equal' | 'reader_behind'
  }
  choice_and_cost: string
  private_detail_anchor: string
  subtext_or_omission: string
  reader_state_after: EmotionStateVector
  arc_role: EmotionArcRole
  emotional_debt_opened: string
  emotional_debt_paid: string
  residue_into_next: string
}

export interface EmotionEngine {
  target_reader: string
  emotional_promise: {
    primary: string
    counter_emotion: string
    catharsis: string
    aftertaste: string
  }
  core_emotional_question: string
  attachment_contracts: Array<{
    subject: string
    valued_object: string
    why_reader_cares: string
    vulnerability: string
    admiration_evidence: string
    contradiction: string
    credible_loss: string
  }>
  core_inner_conflict: {
    wanted: string
    needed: string
    feared_truth: string
    protective_lie: string
  }
  arc_principles: string[]
  recurring_anchors: string[]
}

export type EmotionFailureLayer = 'attachment' | 'arc' | 'scene' | 'continuity' | 'prose' | 'none'

export interface EmotionBlindAssessment {
  passed: boolean
  score: number
  attachment_score: number
  causal_earnedness_score: number
  inferability_score: number
  pov_immediacy_score: number
  subtext_score: number
  modulation_score: number
  residue_score: number
  target_alignment_score: number
  actual_reader_curve: Array<{
    range: string
    emotion: string
    arousal: number
    evidence: string
  }>
  reader_cares_about: string
  reader_hopes: string
  reader_fears: string
  failure_layer: EmotionFailureLayer
  blocking_issues: string[]
  repair_instruction: string
  /** 持久化完整性元数据；旧数据可缺省。 */
  outcome_meta?: {
    content_hash: string
    ledger_complete: boolean
    ledger_schema_version: number
    /** 原始评估未完全通过，但所有承重维度均高于硬伤线，允许带审计债务推进。 */
    accepted_deferred?: boolean
  }
}

export const EMOTION_LEDGER_SCHEMA_VERSION = 2

export interface EmotionLedgerBeliefChange {
  belief: string
  change: string
}

export interface EmotionLedgerRelationshipChange {
  character: string
  state: string
}

export interface EmotionLedgerState {
  character_name: string
  felt_state: string
  displayed_state: string
  unresolved_emotion: string
  protective_strategy: string
  behavioral_aftereffect: string
  belief_changes: EmotionLedgerBeliefChange[]
  relationship_changes: EmotionLedgerRelationshipChange[]
  source_event: string
}

/** 模型原生结构化输出与应用层校验共用同一份 Schema。 */
export const EMOTION_LEDGER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['states'],
  properties: {
    states: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'character_name', 'felt_state', 'displayed_state', 'unresolved_emotion',
          'protective_strategy', 'behavioral_aftereffect', 'belief_changes',
          'relationship_changes', 'source_event'
        ],
        properties: {
          character_name: { type: 'string', minLength: 1 },
          felt_state: { type: 'string', minLength: 1 },
          displayed_state: { type: 'string' },
          unresolved_emotion: { type: 'string' },
          protective_strategy: { type: 'string' },
          behavioral_aftereffect: { type: 'string', minLength: 1 },
          belief_changes: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['belief', 'change'],
              properties: { belief: { type: 'string' }, change: { type: 'string' } }
            }
          },
          relationship_changes: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['character', 'state'],
              properties: { character: { type: 'string' }, state: { type: 'string' } }
            }
          },
          source_event: { type: 'string', minLength: 1 }
        }
      }
    }
  }
}

const ARC_ROLES = new Set<EmotionArcRole>(EMOTION_ARC_ROLES)
const GAP_TYPES = new Set<EmotionContract['information_position']['gap_type']>(EMOTION_GAP_TYPES)

const ARC_ROLE_ALIASES: Record<string, EmotionArcRole> = {
  attach: 'attach', setup: 'attach', opening: 'attach', hook: 'attach',
  build: 'build', rising: 'build', escalation: 'build', develop: 'build',
  hold: 'hold', sustain: 'hold', pause: 'hold', transition: 'hold',
  break: 'break', crisis: 'break', reversal: 'break', turn: 'break',
  release: 'release', climax: 'release', payoff: 'release', catharsis: 'release',
  aftertaste: 'aftertaste', resolution: 'aftertaste', denouement: 'aftertaste', aftermath: 'aftertaste', ending: 'aftertaste',
  '开篇依恋': 'attach', '蓄力': 'build', '维持': 'hold', '破裂': 'break', '高潮': 'release', '兑现': 'release', '余味': 'aftertaste', '结局': 'aftertaste'
}

const GAP_TYPE_ALIASES: Record<string, EmotionContract['information_position']['gap_type']> = {
  reader_ahead: 'reader_ahead', ahead: 'reader_ahead',
  reader_equal: 'reader_equal', equal: 'reader_equal', aligned: 'reader_equal',
  reader_behind: 'reader_behind', behind: 'reader_behind'
}

export function normalizeEmotionArcRole(value: unknown): EmotionArcRole | null {
  const key = text(value).toLowerCase()
  return ARC_ROLE_ALIASES[key] ?? null
}

function normalizeGapType(value: unknown): EmotionContract['information_position']['gap_type'] | null {
  const key = text(value).toLowerCase()
  return GAP_TYPE_ALIASES[key] ?? null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function certaintyText(value: unknown): string {
  const normalized = text(value)
  if (normalized) return normalized
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return ''
  const level = numeric >= 0 && numeric <= 1 ? Math.round(numeric * 4) : Math.round(numeric)
  return `人物判断确定性等级 ${Math.max(0, Math.min(4, level))}/4`
}

function bounded(value: unknown, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.round(n)))
}

function stateVector(value: unknown): EmotionStateVector | null {
  const row = record(value)
  if (!row) return null
  const label = text(row.label)
  if (!label) return null
  return {
    label,
    valence: bounded(row.valence, -2, 2),
    arousal: bounded(row.arousal, 0, 4),
    agency: bounded(row.agency, -2, 2),
    certainty: bounded(row.certainty, 0, 4)
  }
}

export function normalizeEmotionContract(value: unknown): EmotionContract | null {
  const row = record(value)
  if (!row) return null
  const appraisal = record(row.character_appraisal)
  const layers = record(row.character_layers)
  const info = record(row.information_position)
  const before = stateVector(row.reader_state_before)
  const after = stateVector(row.reader_state_after)
  const gap = normalizeGapType(info?.gap_type)
  const arcRole = normalizeEmotionArcRole(row.arc_role)
  if (!appraisal || !layers || !info || !before || !after || !gap || !arcRole || !GAP_TYPES.has(gap) || !ARC_ROLES.has(arcRole)) return null

  const contract: EmotionContract = {
    pov_character: text(row.pov_character),
    attachment_anchor: text(row.attachment_anchor),
    value_at_stake: text(row.value_at_stake),
    reader_state_before: before,
    trigger_event: text(row.trigger_event),
    character_appraisal: {
      perceived_meaning: text(appraisal.perceived_meaning),
      blame_or_cause: text(appraisal.blame_or_cause),
      controllability: text(appraisal.controllability),
      certainty: certaintyText(appraisal.certainty),
      value_or_norm_violated: text(appraisal.value_or_norm_violated)
    },
    character_layers: {
      felt: text(layers.felt),
      admitted: text(layers.admitted),
      displayed: text(layers.displayed),
      suppressed: text(layers.suppressed),
      action_impulse: text(layers.action_impulse)
    },
    information_position: {
      reader_knows: text(info.reader_knows),
      pov_knows: text(info.pov_knows),
      other_knows: text(info.other_knows),
      gap_type: gap
    },
    choice_and_cost: text(row.choice_and_cost),
    private_detail_anchor: text(row.private_detail_anchor),
    subtext_or_omission: text(row.subtext_or_omission),
    reader_state_after: after,
    arc_role: arcRole,
    emotional_debt_opened: text(row.emotional_debt_opened),
    emotional_debt_paid: text(row.emotional_debt_paid),
    residue_into_next: text(row.residue_into_next)
  }
  // 解析只负责结构与类型归一化，字段完整性由知道章节位置的调用方校验。
  // 否则一个空字段会让整份合同变成 null，门禁只能误报“缺少 emotion_contract”。
  return contract
}

export function validateEmotionContract(
  contract: EmotionContract,
  options: { isFinalBeat?: boolean } = {}
): string[] {
  const required: Array<[string, string]> = [
    ['pov_character', contract.pov_character],
    ['attachment_anchor', contract.attachment_anchor],
    ['value_at_stake', contract.value_at_stake],
    ['trigger_event', contract.trigger_event],
    ['perceived_meaning', contract.character_appraisal.perceived_meaning],
    ['certainty', contract.character_appraisal.certainty],
    ['felt', contract.character_layers.felt],
    ['displayed', contract.character_layers.displayed],
    ['action_impulse', contract.character_layers.action_impulse],
    ['choice_and_cost', contract.choice_and_cost],
    ['private_detail_anchor', contract.private_detail_anchor],
    ['subtext_or_omission', contract.subtext_or_omission]
  ]
  if (!options.isFinalBeat) required.push(['residue_into_next', contract.residue_into_next])
  return required.filter(([, value]) => !value.trim()).map(([key]) => `缺少 ${key}`)
}

export function formatEmotionContractForPrompt(contract: EmotionContract): string {
  return [
    '【本章情绪执行卡 - 以因果与选择制造读者情绪，禁止直接复述字段】',
    `- 视角人物：${contract.pov_character}`,
    `- 读者依恋锚点：${contract.attachment_anchor}`,
    `- 被威胁/兑现的价值：${contract.value_at_stake}`,
    `- 读者进入状态：${contract.reader_state_before.label}（效价${contract.reader_state_before.valence}/唤醒${contract.reader_state_before.arousal}/能动${contract.reader_state_before.agency}）`,
    `- 触发事件：${contract.trigger_event}`,
    `- 人物赋予事件的意义：${contract.character_appraisal.perceived_meaning}`,
    `- 真实感受：${contract.character_layers.felt}`,
    `- 愿意承认：${contract.character_layers.admitted || '不愿承认'}`,
    `- 对外表现：${contract.character_layers.displayed}`,
    `- 压抑/隐藏：${contract.character_layers.suppressed}`,
    `- 信息位置：读者知道「${contract.information_position.reader_knows}」；人物知道「${contract.information_position.pov_knows}」；${contract.information_position.gap_type}`,
    `- 情绪驱动的选择与代价：${contract.choice_and_cost}`,
    `- 私人化细节锚点：${contract.private_detail_anchor}`,
    `- 潜台词/留白：${contract.subtext_or_omission}`,
    `- 读者离场状态：${contract.reader_state_after.label}（效价${contract.reader_state_after.valence}/唤醒${contract.reader_state_after.arousal}/能动${contract.reader_state_after.agency}）`,
    `- 情绪弧功能：${contract.arc_role}`,
    contract.emotional_debt_opened ? `- 新增情绪债：${contract.emotional_debt_opened}` : '',
    contract.emotional_debt_paid ? `- 本章兑现：${contract.emotional_debt_paid}` : '',
    `- 带入下一章的余波：${contract.residue_into_next}`,
    '执行原则：让情绪改变人物的注意、误读、语言和选择；读者能从证据推断时不要再由旁白解释。'
  ].filter(Boolean).join('\n')
}
