import { coreSettingDAO, workDAO } from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import { parseJsonObjectWithRepairs } from '../../../shared/model-json-repair'
import { withGoalLoopModelOptions } from './story-goal-model'
import { GoalPhaseExhaustedError } from './goal-phase-error'

export interface StoryContract {
  core_question: string
  core_conflict: string
  chronology: string[]
  protagonist_plan: {
    visible_layer: string
    hidden_layer: string
    cost: string
    failure_risk: string
  }
  opponent_countermoves: string[]
  climax_mechanism: string
  ending_mode: 'closed' | 'bittersweet' | 'open_aftertaste'
  must_resolve: string[]
  forbidden_final_threads: string[]
  fair_clues: string[]
  rule_proofs: Array<{
    rule: string
    authority: string
    trigger: string
    required_evidence: string
    consequence: string
    why_unavoidable: string
  }>
  climax_evidence_chain: Array<{
    evidence: string
    source: string
    seeded_in: string
    holder: string
    trigger_action: string
    proves: string
    consequence: string
  }>
}

const STORY_CONTRACT_RESPONSE_SCHEMA = {
  type: 'object',
  required: [
    'core_question', 'core_conflict', 'chronology', 'protagonist_plan',
    'opponent_countermoves', 'climax_mechanism', 'ending_mode',
    'must_resolve', 'forbidden_final_threads', 'fair_clues',
    'rule_proofs', 'climax_evidence_chain'
  ],
  properties: {
    core_question: { type: 'string' }, core_conflict: { type: 'string' },
    chronology: { type: 'array', items: { type: 'string' } },
    protagonist_plan: { type: 'object' }, opponent_countermoves: { type: 'array', items: { type: 'string' } },
    climax_mechanism: { type: 'string' }, ending_mode: { type: 'string' },
    must_resolve: { type: 'array', items: { type: 'string' } },
    forbidden_final_threads: { type: 'array', items: { type: 'string' } },
    fair_clues: { type: 'array', items: { type: 'string' } },
    rule_proofs: { type: 'array', items: { type: 'object' } },
    climax_evidence_chain: { type: 'array', items: { type: 'object' } }
  }
}
const STORY_CONTRACT_AUDIT_SCHEMA = {
  type: 'object',
  required: ['blockers'],
  properties: {
    blockers: { type: 'array', maxItems: 6, items: { type: 'string' } }
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : []
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>
    : []
}

function parseStoryContract(content: string): StoryContract {
  const json = extractJsonText(content.trim()) ?? content.trim()
  const raw = parseJsonObjectWithRepairs<Record<string, unknown>>(json).value
  const plan = raw.protagonist_plan && typeof raw.protagonist_plan === 'object'
    ? raw.protagonist_plan as Record<string, unknown>
    : {}
  const ending = String(raw.ending_mode ?? '')
  const contract: StoryContract = {
    core_question: String(raw.core_question ?? '').trim(),
    core_conflict: String(raw.core_conflict ?? '').trim(),
    chronology: strings(raw.chronology),
    protagonist_plan: {
      visible_layer: String(plan.visible_layer ?? '').trim(),
      hidden_layer: String(plan.hidden_layer ?? '').trim(),
      cost: String(plan.cost ?? '').trim(),
      failure_risk: String(plan.failure_risk ?? '').trim()
    },
    opponent_countermoves: strings(raw.opponent_countermoves),
    climax_mechanism: String(raw.climax_mechanism ?? '').trim(),
    ending_mode: ['closed', 'bittersweet', 'open_aftertaste'].includes(ending)
      ? ending as StoryContract['ending_mode']
      : 'closed',
    must_resolve: strings(raw.must_resolve),
    forbidden_final_threads: strings(raw.forbidden_final_threads).length > 0
      ? strings(raw.forbidden_final_threads)
      : ['未经铺垫的新反派', '新的主线任务', '续集式威胁'],
    fair_clues: strings(raw.fair_clues),
    rule_proofs: records(raw.rule_proofs).map(row => ({
      rule: String(row.rule ?? '').trim(),
      authority: String(row.authority ?? '').trim(),
      trigger: String(row.trigger ?? '').trim(),
      required_evidence: String(row.required_evidence ?? '').trim(),
      consequence: String(row.consequence ?? '').trim(),
      why_unavoidable: String(row.why_unavoidable ?? '').trim()
    })),
    climax_evidence_chain: records(raw.climax_evidence_chain).map(row => ({
      evidence: String(row.evidence ?? '').trim(),
      source: String(row.source ?? '').trim(),
      seeded_in: String(row.seeded_in ?? '').trim(),
      holder: String(row.holder ?? '').trim(),
      trigger_action: String(row.trigger_action ?? '').trim(),
      proves: String(row.proves ?? '').trim(),
      consequence: String(row.consequence ?? '').trim()
    }))
  }
  const missing = [
    !contract.core_question && 'core_question',
    !contract.core_conflict && 'core_conflict',
    contract.chronology.length < 3 && 'chronology',
    !contract.protagonist_plan.cost && 'protagonist_plan.cost',
    !contract.protagonist_plan.failure_risk && 'protagonist_plan.failure_risk',
    contract.opponent_countermoves.length === 0 && 'opponent_countermoves',
    !contract.climax_mechanism && 'climax_mechanism',
    contract.must_resolve.length === 0 && 'must_resolve',
    contract.climax_evidence_chain.length === 0 && 'climax_evidence_chain',
    contract.climax_evidence_chain.some(row => Object.values(row).some(value => !value)) && 'climax_evidence_chain.*',
    contract.rule_proofs.some(row => Object.values(row).some(value => !value)) && 'rule_proofs.*'
  ].filter(Boolean)
  if (missing.length > 0) throw new Error(`故事合同缺少承重字段：${missing.join('、')}`)
  return contract
}

function sourceContext(workId: number): string {
  return coreSettingDAO.listByWork(workId)
    .filter(setting => ['idea', 'protagonist', 'golden_finger', 'pleasure_engine', 'supporting_cast', 'story_engine', 'emotion_engine'].includes(setting.type))
    .map(setting => `## ${setting.type}\n${setting.content}`)
    .join('\n\n')
}

export function getStoryContract(workId: number): StoryContract | null {
  const raw = coreSettingDAO.getStructuredContent(workId, 'story_contract')
  if (!raw) return null
  try {
    return parseStoryContract(raw)
  } catch {
    return null
  }
}

export function formatStoryContractForPrompt(workId: number): string {
  const contract = getStoryContract(workId)
  return contract ? `【全篇故事合同 - 不得改写】\n${JSON.stringify(contract, null, 2)}` : ''
}

async function auditStoryContract(
  workId: number,
  contract: StoryContract,
  source: string,
  signal?: AbortSignal
): Promise<string[]> {
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_contract_semantic_audit',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 1400,
      forceThinkingDisabled: true,
      responseSchema: { name: 'short_story_contract_audit', schema: STORY_CONTRACT_AUDIT_SCHEMA, strict: false },
      systemPrompt: [
        '你是独立短故事合同审计员，不参与生成，只否决承重因果不成立的合同。',
        '逐条审查 rule_proofs：制定者是否真有权限，触发条件与证据能否支持后果，主角是否可以轻易拒绝或正常申诉绕开。题材夸张可以，但制度不能自相矛盾或只为打脸临时发明。',
        '逐条审查 climax_evidence_chain：决定性事实必须提前出现、来源和持有人稳定，并由人物行动触发；自动弹文件、恰好群发消息、临时权威背书、反派主动送证据均为 blocker。',
        '高潮必须由主角或对手的选择造成，不得依赖双方此前都不知道的新事实。',
        '只输出 JSON：{"blockers":["具体冲突与需要重建的字段"]}；无硬伤返回空数组。'
      ].join('\n\n'),
      prompt: `【上游设定】\n${source}\n\n【候选故事合同】\n${JSON.stringify(contract, null, 2)}`
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(response.error || '故事合同独立语义审计无返回')
  }
  const json = extractJsonText(response.content.trim()) ?? response.content.trim()
  const parsed = parseJsonObjectWithRepairs<{ blockers?: unknown }>(json).value
  if (!Array.isArray(parsed.blockers)) throw new Error('故事合同独立语义审计缺少 blockers 数组')
  return parsed.blockers.map(String).map(item => item.trim()).filter(Boolean).slice(0, 6)
}

export async function ensureStoryContract(
  workId: number,
  goal: string,
  structuralFeedback = '',
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<StoryContract> {
  const existing = getStoryContract(workId)
  if (existing && !structuralFeedback.trim()) return existing
  const work = workDAO.getById(workId)
  let feedback = structuralFeedback
  for (let round = 1; round <= 4; round++) {
    if (signal?.aborted) throw new Error('已取消')
    onProgress?.(`正在固化全篇故事合同（第 ${round}/4 轮）`)
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'story_contract_gate',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0.1,
        maxTokens: 3000,
        forceThinkingDisabled: true,
        responseSchema: { name: 'short_story_contract', schema: STORY_CONTRACT_RESPONSE_SCHEMA, strict: false },
        systemPrompt: [
          '你是短故事总架构师。把已有设定固化为全篇唯一事实合同，后续所有节拍和正文必须服从它。',
          '若 story_engine.setting_resolutions 非空，它是对上游含糊或互斥表述的权威口径；合同必须采用该口径，不得把旧冲突重新写回。',
          '合同必须给出唯一时间顺序、主角计划的表里两层、真实代价、失败风险、对手至少一次有效反制、高潮的因果机制和结局必须回收的承诺。',
          '凡学校、公司、法律、竞赛、评奖、福利或平台规则推动剧情，必须写入 rule_proofs：制定者、触发条件、所需证据、后果，以及主角为什么不能通过拒绝或正常申诉绕开。没有制度规则时返回空数组。',
          'climax_evidence_chain 必须逐项证明高潮证据的来源、前置出现位置、持有人、由谁采取什么动作触发、能证明什么、造成什么后果。禁止自动弹出的文件、恰好群发的短信、临时出现的权威背书或主角此前不知道的新证据。',
          '高潮不得依赖巧合、反派主动自曝、临时权威或突然出现的证据。结局不得为了续集感引入未经铺垫的新反派。',
          '只输出合法 JSON，不要 markdown。',
          '格式：{"core_question":"...","core_conflict":"...","chronology":["..."],"protagonist_plan":{"visible_layer":"...","hidden_layer":"...","cost":"...","failure_risk":"..."},"opponent_countermoves":["..."],"climax_mechanism":"...","ending_mode":"closed|bittersweet|open_aftertaste","must_resolve":["..."],"forbidden_final_threads":["..."],"fair_clues":["..."],"rule_proofs":[{"rule":"...","authority":"...","trigger":"...","required_evidence":"...","consequence":"...","why_unavoidable":"..."}],"climax_evidence_chain":[{"evidence":"...","source":"...","seeded_in":"...","holder":"...","trigger_action":"...","proves":"...","consequence":"..."}]}'
        ].join('\n\n'),
        prompt: [
          `【作品】${work?.title || '未命名短故事'}`,
          `【创作目标】${goal.trim() || '高完读率、人物可信、因果完整的短故事'}`,
          `【现有设定】\n${sourceContext(workId)}`,
          feedback ? `【必须修复的问题】\n${feedback}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) {
      feedback = `模型调用失败：${response.error || '故事合同生成无返回'}。请重新输出完整合同。`
      continue
    }
    if (response.finishReason === 'length') {
      feedback = '上一轮合同输出达到长度上限。必须压缩 chronology 和数组项并重新输出完整 JSON。'
      continue
    }
    try {
      const contract = parseStoryContract(response.content)
      const blockers = await auditStoryContract(workId, contract, sourceContext(workId), signal)
      if (blockers.length > 0) {
        feedback = `独立合同审计未通过：${blockers.join('；')}`
        onProgress?.(`故事合同因果审计未通过（第 ${round}/4 轮），正在重建`)
        continue
      }
      coreSettingDAO.upsertStructured(
        workId,
        'story_contract',
        `# 全篇故事合同\n\n${JSON.stringify(contract, null, 2)}`,
        JSON.stringify(contract)
      )
      onProgress?.('全篇故事合同已固化')
      return contract
    } catch (error) {
      feedback = error instanceof Error ? error.message : String(error)
    }
  }
  throw new GoalPhaseExhaustedError(`全篇故事合同连续4轮未通过：${feedback}`)
}
