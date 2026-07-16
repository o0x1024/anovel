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
}

const STORY_CONTRACT_RESPONSE_SCHEMA = {
  type: 'object',
  required: [
    'core_question', 'core_conflict', 'chronology', 'protagonist_plan',
    'opponent_countermoves', 'climax_mechanism', 'ending_mode',
    'must_resolve', 'forbidden_final_threads', 'fair_clues'
  ],
  properties: {
    core_question: { type: 'string' }, core_conflict: { type: 'string' },
    chronology: { type: 'array', items: { type: 'string' } },
    protagonist_plan: { type: 'object' }, opponent_countermoves: { type: 'array', items: { type: 'string' } },
    climax_mechanism: { type: 'string' }, ending_mode: { type: 'string' },
    must_resolve: { type: 'array', items: { type: 'string' } },
    forbidden_final_threads: { type: 'array', items: { type: 'string' } },
    fair_clues: { type: 'array', items: { type: 'string' } }
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : []
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
    fair_clues: strings(raw.fair_clues)
  }
  const missing = [
    !contract.core_question && 'core_question',
    !contract.core_conflict && 'core_conflict',
    contract.chronology.length < 3 && 'chronology',
    !contract.protagonist_plan.cost && 'protagonist_plan.cost',
    !contract.protagonist_plan.failure_risk && 'protagonist_plan.failure_risk',
    contract.opponent_countermoves.length === 0 && 'opponent_countermoves',
    !contract.climax_mechanism && 'climax_mechanism',
    contract.must_resolve.length === 0 && 'must_resolve'
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
          '高潮不得依赖巧合、反派主动自曝、临时权威或突然出现的证据。结局不得为了续集感引入未经铺垫的新反派。',
          '只输出合法 JSON，不要 markdown。',
          '格式：{"core_question":"...","core_conflict":"...","chronology":["..."],"protagonist_plan":{"visible_layer":"...","hidden_layer":"...","cost":"...","failure_risk":"..."},"opponent_countermoves":["..."],"climax_mechanism":"...","ending_mode":"closed|bittersweet|open_aftertaste","must_resolve":["..."],"forbidden_final_threads":["..."],"fair_clues":["..."]}'
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
