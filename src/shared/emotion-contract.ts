export type EmotionArcRole = 'attach' | 'build' | 'hold' | 'break' | 'release' | 'aftertaste'

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
}

const ARC_ROLES = new Set<EmotionArcRole>(['attach', 'build', 'hold', 'break', 'release', 'aftertaste'])
const GAP_TYPES = new Set<EmotionContract['information_position']['gap_type']>(['reader_ahead', 'reader_equal', 'reader_behind'])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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
  const gap = text(info?.gap_type) as EmotionContract['information_position']['gap_type']
  const arcRole = text(row.arc_role) as EmotionArcRole
  if (!appraisal || !layers || !info || !before || !after || !GAP_TYPES.has(gap) || !ARC_ROLES.has(arcRole)) return null

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
      certainty: text(appraisal.certainty),
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
  return validateEmotionContract(contract).length === 0 ? contract : null
}

export function validateEmotionContract(contract: EmotionContract): string[] {
  const required: Array<[string, string]> = [
    ['pov_character', contract.pov_character],
    ['attachment_anchor', contract.attachment_anchor],
    ['value_at_stake', contract.value_at_stake],
    ['trigger_event', contract.trigger_event],
    ['perceived_meaning', contract.character_appraisal.perceived_meaning],
    ['felt', contract.character_layers.felt],
    ['displayed', contract.character_layers.displayed],
    ['choice_and_cost', contract.choice_and_cost],
    ['private_detail_anchor', contract.private_detail_anchor],
    ['subtext_or_omission', contract.subtext_or_omission],
    ['residue_into_next', contract.residue_into_next]
  ]
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
