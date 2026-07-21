import { causalNovelDAO, coreSettingDAO, volumeChapterDAO, workDAO } from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import { buildWorkContext } from '../work-context'
import {
  CAUSAL_NOVEL_SCHEMA_VERSION,
  applyCausalChapterOutcome,
  causalEmotionGroundingRefs,
  formatCausalDecisionCard,
  validateCausalChapterEmotionContract,
  type CausalChapterOutcome,
  type CausalChapterPlan,
  type CausalNarrativeState
} from '../../../shared/causal-novel-types'
import { withGoalLoopModelOptions } from './story-goal-model'

const INITIAL_STATE_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  required: ['centralQuestion', 'terminalConditions', 'immutableRules', 'actors', 'activePressures', 'promises'],
  properties: {
    centralQuestion: { type: 'string' },
    terminalConditions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
    immutableRules: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
    actors: {
      type: 'array', minItems: 2, maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'currentGoal', 'fear', 'knowledge', 'resources', 'constraint'],
        properties: {
          name: { type: 'string' }, currentGoal: { type: 'string' }, fear: { type: 'string' },
          knowledge: { type: 'array', items: { type: 'string' } },
          resources: { type: 'array', items: { type: 'string' } }, constraint: { type: 'string' }
        }
      }
    },
    activePressures: {
      type: 'array', minItems: 1, maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'source', 'target', 'condition', 'escalation', 'urgency', 'status'],
        properties: {
          id: { type: 'string' }, source: { type: 'string' }, target: { type: 'string' },
          condition: { type: 'string' }, escalation: { type: 'string' },
          urgency: { type: 'integer', minimum: 1, maximum: 10 }, status: { type: 'string', const: 'active' }
        }
      }
    },
    promises: {
      type: 'array', minItems: 1, maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'question'],
        properties: { id: { type: 'string' }, question: { type: 'string' } }
      }
    }
  }
}

const PRESSURE_ITEM_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'source', 'target', 'condition', 'escalation', 'urgency', 'status'],
  properties: {
    id: { type: 'string' }, source: { type: 'string' }, target: { type: 'string' },
    condition: { type: 'string' }, escalation: { type: 'string' },
    urgency: { type: 'integer', minimum: 1, maximum: 10 },
    status: { type: 'string', enum: ['active', 'resolved'] }
  }
}

const CANDIDATE_SCORE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['causalNecessity', 'promiseProgress', 'irreversibleImpact', 'novelty', 'pressureEscalation', 'total'],
  properties: Object.fromEntries(
    ['causalNecessity', 'promiseProgress', 'irreversibleImpact', 'novelty', 'pressureEscalation', 'total']
      .map(key => [key, { type: 'integer', minimum: 0, maximum: 100 }])
  )
}

const EMOTION_STATE_VECTOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['label', 'valence', 'arousal', 'agency', 'certainty'],
  properties: {
    label: { type: 'string' },
    valence: { type: 'integer', minimum: -2, maximum: 2 },
    arousal: { type: 'integer', minimum: 0, maximum: 4 },
    agency: { type: 'integer', minimum: -2, maximum: 2 },
    certainty: { type: 'integer', minimum: 0, maximum: 4 }
  }
}

const CAUSAL_EMOTION_CONTRACT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [
    'pov_character', 'attachment_anchor', 'value_at_stake', 'reader_state_before',
    'trigger_event', 'character_appraisal', 'character_layers', 'information_position',
    'choice_and_cost', 'private_detail_anchor', 'subtext_or_omission', 'reader_state_after',
    'arc_role', 'emotional_debt_opened', 'emotional_debt_paid', 'residue_into_next',
    'grounding_refs'
  ],
  properties: {
    pov_character: { type: 'string' },
    attachment_anchor: { type: 'string' },
    value_at_stake: { type: 'string' },
    reader_state_before: EMOTION_STATE_VECTOR_SCHEMA,
    trigger_event: { type: 'string' },
    character_appraisal: {
      type: 'object', additionalProperties: false,
      required: ['perceived_meaning', 'blame_or_cause', 'controllability', 'certainty', 'value_or_norm_violated'],
      properties: {
        perceived_meaning: { type: 'string' }, blame_or_cause: { type: 'string' },
        controllability: { type: 'string' }, certainty: { type: 'string' },
        value_or_norm_violated: { type: 'string' }
      }
    },
    character_layers: {
      type: 'object', additionalProperties: false,
      required: ['felt', 'admitted', 'displayed', 'suppressed', 'action_impulse'],
      properties: {
        felt: { type: 'string' }, admitted: { type: 'string' }, displayed: { type: 'string' },
        suppressed: { type: 'string' }, action_impulse: { type: 'string' }
      }
    },
    information_position: {
      type: 'object', additionalProperties: false,
      required: ['reader_knows', 'pov_knows', 'other_knows', 'gap_type'],
      properties: {
        reader_knows: { type: 'string' }, pov_knows: { type: 'string' }, other_knows: { type: 'string' },
        gap_type: { type: 'string', enum: ['reader_ahead', 'reader_equal', 'reader_behind'] }
      }
    },
    choice_and_cost: { type: 'string' },
    private_detail_anchor: { type: 'string' },
    subtext_or_omission: { type: 'string' },
    reader_state_after: EMOTION_STATE_VECTOR_SCHEMA,
    arc_role: { type: 'string', enum: ['attach', 'build', 'hold', 'break', 'release', 'aftertaste'] },
    emotional_debt_opened: { type: 'string' },
    emotional_debt_paid: { type: 'string' },
    residue_into_next: { type: 'string' },
    grounding_refs: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'string' } }
  }
}

const CHAPTER_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  required: ['candidates', 'selectedCandidateId', 'decision', 'emotionContract'],
  properties: {
    candidates: {
      type: 'array', minItems: 3, maxItems: 5,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'initiator', 'action', 'opposition', 'cost', 'irreversibleChange', 'promiseAdvanced', 'newQuestion', 'scores'],
        properties: {
          id: { type: 'string' }, initiator: { type: 'string' }, action: { type: 'string' },
          opposition: { type: 'string' }, cost: { type: 'string' }, irreversibleChange: { type: 'string' },
          promiseAdvanced: { type: 'string' }, newQuestion: { type: 'string' }, scores: CANDIDATE_SCORE_SCHEMA
        }
      }
    },
    selectedCandidateId: { type: 'string' },
    decision: {
      type: 'object', additionalProperties: false,
      required: [
        'title', 'pov', 'initiator', 'immediateWant', 'chosenAction', 'opposition', 'cost',
        'openingState', 'mustCover', 'forbiddenEvents', 'endingState', 'continuityConstraints',
        'characters', 'advancedPromiseIds', 'newQuestion'
      ],
      properties: {
        title: { type: 'string' }, pov: { type: 'string' }, initiator: { type: 'string' },
        immediateWant: { type: 'string' }, chosenAction: { type: 'string' }, opposition: { type: 'string' },
        cost: { type: 'string' }, openingState: { type: 'string' },
        mustCover: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
        forbiddenEvents: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
        endingState: { type: 'string' },
        continuityConstraints: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
        characters: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
        advancedPromiseIds: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
        newQuestion: { type: 'string' }
      }
    },
    emotionContract: CAUSAL_EMOTION_CONTRACT_SCHEMA
  }
}

const OUTCOME_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  required: [
    'summary', 'eventSignature', 'evidenceQuotes', 'advancedPromiseIds', 'resolvedPromiseIds',
    'newPromises', 'actorUpdates', 'pressureUpdates', 'newPressures', 'emotionalOutcome',
    'terminalConditionMet', 'completionReason'
  ],
  properties: {
    summary: { type: 'string' }, eventSignature: { type: 'string' },
    evidenceQuotes: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
    advancedPromiseIds: { type: 'array', items: { type: 'string' } },
    resolvedPromiseIds: { type: 'array', items: { type: 'string' } },
    newPromises: {
      type: 'array', maxItems: 4, items: {
        type: 'object', additionalProperties: false, required: ['id', 'question'],
        properties: { id: { type: 'string' }, question: { type: 'string' } }
      }
    },
    actorUpdates: {
      type: 'array', maxItems: 12, items: {
        type: 'object', additionalProperties: false, required: ['actor', 'evidence'],
        properties: {
          actor: { type: 'string' }, currentGoal: { type: 'string' },
          knowledgeAdded: { type: 'array', items: { type: 'string' } },
          resourcesAdded: { type: 'array', items: { type: 'string' } },
          resourcesRemoved: { type: 'array', items: { type: 'string' } },
          constraint: { type: 'string' }, evidence: { type: 'string' }
        }
      }
    },
    pressureUpdates: {
      type: 'array', maxItems: 12, items: {
        type: 'object', additionalProperties: false, required: ['id', 'status', 'evidence'],
        properties: {
          id: { type: 'string' }, status: { type: 'string', enum: ['unchanged', 'escalated', 'resolved'] },
          condition: { type: 'string' }, urgency: { type: 'integer', minimum: 1, maximum: 10 },
          evidence: { type: 'string' }
        }
      }
    },
    newPressures: {
      type: 'array', maxItems: 6, items: {
        type: 'object', additionalProperties: false, required: ['pressure', 'evidence'],
        properties: { pressure: PRESSURE_ITEM_SCHEMA, evidence: { type: 'string' } }
      }
    },
    emotionalOutcome: {
      type: 'object', additionalProperties: false,
      required: [
        'readerEffectSummary', 'triggerEvidence', 'choiceEvidence', 'costEvidence',
        'residueEvidence', 'emotionalDebtOpened', 'emotionalDebtPaid'
      ],
      properties: {
        readerEffectSummary: { type: 'string' }, triggerEvidence: { type: 'string' },
        choiceEvidence: { type: 'string' }, costEvidence: { type: 'string' },
        residueEvidence: { type: 'string' }, emotionalDebtOpened: { type: 'string' },
        emotionalDebtPaid: { type: 'string' }
      }
    },
    terminalConditionMet: { type: 'boolean' }, completionReason: { type: 'string' }
  }
}

function parseStructured<T>(content: string): T {
  const json = extractJsonText(content.trim()) ?? content.trim()
  return JSON.parse(json) as T
}

function causalSeed(workId: number, goal: string): string {
  const work = workDAO.getById(workId)
  const worldview = coreSettingDAO.getByType(workId, 'worldview')?.content?.trim()
    || coreSettingDAO.getByType(workId, 'world_pressure')?.content?.trim()
  const seed = [work?.description?.trim(), worldview, goal.trim()].filter(Boolean).join('\n\n')
  if (!seed) throw new Error('因果小说需要先填写世界起点或创作目标')
  return seed
}

function validateInitialState(state: CausalNarrativeState): void {
  if (!state.centralQuestion.trim()) throw new Error('核心戏剧问题为空')
  if (state.actors.length < 2) throw new Error('至少需要两个能独立行动的人物')
  if (state.activePressures.length === 0) throw new Error('至少需要一个当前压力')
  if (new Set(state.actors.map(actor => actor.name)).size !== state.actors.length) throw new Error('人物名称重复')
  if (new Set(state.activePressures.map(item => item.id)).size !== state.activePressures.length) throw new Error('压力 ID 重复')
  if (new Set(state.promises.map(item => item.id)).size !== state.promises.length) throw new Error('读者承诺 ID 重复')
}

export async function initializeCausalNovelState(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<CausalNarrativeState> {
  const existing = causalNovelDAO.getState(workId)
  if (existing) return existing
  if (volumeChapterDAO.listChaptersByWork(workId).length > 0) {
    throw new Error('因果小说必须从空作品初始化，不能接管已有传统大纲或章节')
  }
  onProgress?.('初始状态 1/3：正在整理世界起点与硬规则')
  const seed = causalSeed(workId, goal)
  onProgress?.('初始状态 2/3：正在请求模型建立人物、世界压力与读者承诺')
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId, step: 'goal_novel_causal_state', enrichWorkContext: false, enrichNarrativeMemory: false,
      temperature: 0.2, maxTokens: 5000,
      responseSchema: { name: 'causal_novel_initial_state', schema: INITIAL_STATE_SCHEMA, strict: true },
      systemPrompt: [
        '你是滚动因果小说的初始状态建模器。只建立当前状态，不生成全书大纲、分卷、章节安排或人物关系未来路线。',
        '剧情发动机只能来自人物目标、世界压力、信息差、资源约束、读者承诺与行动代价。',
        '人物关系只能作为已知事实，不得建立关系分值、关系阶段或以关系变化作为独立发动机。',
        'terminalConditions 是核心问题得到不可逆回答的判定条件，不得写成预设结局步骤。'
      ].join('\n'),
      prompt: `【世界起点】\n${seed}`
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) throw new Error(response.error || '因果初始状态生成失败')
  const raw = parseStructured<Omit<CausalNarrativeState, 'schemaVersion' | 'revision' | 'recentEventSignatures' | 'completed' | 'completionReason'>>(response.content)
  const state: CausalNarrativeState = {
    ...raw,
    schemaVersion: CAUSAL_NOVEL_SCHEMA_VERSION,
    revision: 0,
    promises: raw.promises.map(item => ({ ...item, status: 'open', openedChapter: 0, lastAdvancedChapter: 0 })),
    recentEventSignatures: [], completed: false, completionReason: ''
  }
  onProgress?.('初始状态 3/3：正在校验并写入权威因果状态')
  validateInitialState(state)
  causalNovelDAO.createState(workId, state)
  return state
}

function validateChapterPlan(state: CausalNarrativeState, plan: CausalChapterPlan): void {
  const candidate = plan.candidates.find(item => item.id === plan.selectedCandidateId)
  if (!candidate) throw new Error('所选因果候选不存在')
  const bestScore = Math.max(...plan.candidates.map(item => item.scores.total))
  if (candidate.scores.total !== bestScore) throw new Error('所选候选不是本轮总分最高项')
  const promiseIds = new Set(state.promises.filter(item => item.status !== 'resolved').map(item => item.id))
  for (const id of plan.decision.advancedPromiseIds) {
    if (!promiseIds.has(id)) throw new Error(`决策引用不存在或已关闭的读者承诺：${id}`)
  }
  const actorNames = new Set(state.actors.map(actor => actor.name))
  if (!actorNames.has(plan.decision.initiator)) throw new Error('决策发起人不在当前人物状态中')
  if (plan.decision.mustCover.length < 2) throw new Error('章节决策缺少可验收因果节点')
}

export async function planNextCausalChapter(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ chapterId: number; plan: CausalChapterPlan }> {
  onProgress?.('章节决策 1/4：正在读取权威状态与最近正文')
  const state = causalNovelDAO.getState(workId)
  if (!state) throw new Error('因果状态尚未初始化')
  if (state.completed) throw new Error(`核心问题已经收束：${state.completionReason}`)
  const existingPending = causalNovelDAO.listDecisions(workId).find(item => item.status === 'planned')
  if (existingPending) throw new Error(`第 ${existingPending.chapterId} 章决策尚未提交，禁止规划下一章`)
  const recent = volumeChapterDAO.listChaptersByWork(workId).slice(-3)
    .map((chapter, index) => `最近${recentOrdinal(index, 3)}章：${chapter.title}\n${chapter.content?.slice(-1200) ?? ''}`)
    .join('\n\n')
  const recentChapterIds = volumeChapterDAO.listChaptersByWork(workId).slice(-3).map(chapter => chapter.id)
  const recentEmotionalOutcomes = causalNovelDAO.listDecisions(workId).slice(-3)
    .map(item => item.outcome?.emotionalOutcome)
    .filter(Boolean)
  const context = buildWorkContext(workId, { includeVolumes: false, includeCoreSettings: true }).text.slice(0, 5000)
  onProgress?.('章节决策 2/4：正在生成并评分互斥候选事件')
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId, step: 'goal_novel_causal_decision', enrichWorkContext: false, enrichNarrativeMemory: false,
      temperature: 0.35, maxTokens: 6000,
      responseSchema: { name: 'causal_novel_chapter_plan', schema: CHAPTER_PLAN_SCHEMA, strict: true },
      systemPrompt: [
        '你是滚动因果小说的下一章决策器。基于当前权威状态提出3-5个互斥候选，只选择总分最高者。',
        '禁止生成全书大纲、分卷计划、人物关系未来路线或为了制造冲突让人物降智。',
        '候选必须由人物当前目标与认知、世界压力、资源约束、未兑现读者承诺共同推出。',
        '每章必须产生有正文证据的不可逆变化并推进至少一个未关闭承诺。',
        '关系变化不是评分项，也不能作为候选成立的唯一理由。',
        'emotionContract 是当前章节的情绪事务，不是全书情绪路线。它只能引用 grounding_refs 列表中的权威依据。',
        'attachment_anchor 和 private_detail_anchor 必须落在当前人物、资源、压力、规则或已提交正文上；禁止虚构过去共同经历、未来关系阶段或未发生场景。',
        'choice_and_cost 必须与本章 selected decision 的行动和代价一致，情绪必须通过人物选择改变剧情。'
      ].join('\n'),
      prompt: [
        `【用户目标】\n${goal.trim()}`,
        `【当前权威因果状态】\n${JSON.stringify(state, null, 2)}`,
        `【emotionContract 允许引用的 grounding_refs】\n${causalEmotionGroundingRefs(state, recentChapterIds).join('\n')}`,
        recentEmotionalOutcomes.length
          ? `【最近已提交情绪结果，只用于延续余波】\n${JSON.stringify(recentEmotionalOutcomes, null, 2)}`
          : '',
        context ? `【作品硬规则与设定】\n${context}` : '',
        recent ? `【最近正文，仅用于避免重复与保持连续】\n${recent}` : ''
      ].filter(Boolean).join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) throw new Error(response.error || '下一章因果决策生成失败')
  onProgress?.('章节决策 3/4：正在校验候选、人物动机、读者承诺与情绪事务权威引用')
  const plan = parseStructured<CausalChapterPlan>(response.content)
  validateChapterPlan(state, plan)
  validateCausalChapterEmotionContract(state, plan, recentChapterIds)
  onProgress?.('章节决策 4/4：正在创建本章决策事务')
  const chapterId = causalNovelDAO.createPlannedChapter({
    workId, stateRevision: state.revision, plan, decisionCard: formatCausalDecisionCard(plan)
  })
  return { chapterId, plan }
}

function recentOrdinal(index: number, total: number): string {
  return String(total - index)
}

export async function extractCausalOutcome(
  workId: number,
  chapterId: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ state: CausalNarrativeState; outcome: CausalChapterOutcome }> {
  onProgress?.('状态提取 1/3：正在读取最终正文与提交前状态')
  const state = causalNovelDAO.getState(workId)
  const record = causalNovelDAO.getDecision(chapterId)
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!state || !record || !chapter?.content?.trim()) throw new Error('因果结果提交缺少状态、决策或正文')
  if (record.stateRevision !== state.revision) throw new Error('因果结果基于过期状态，拒绝提交')
  onProgress?.('状态提取 2/3：正在从正文提取因果变化与情绪结果证据')
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId, chapterId, step: 'goal_novel_causal_outcome', enrichWorkContext: false, enrichNarrativeMemory: false,
      temperature: 0, maxTokens: 5000,
      responseSchema: { name: 'causal_novel_chapter_outcome', schema: OUTCOME_SCHEMA, strict: false },
      systemPrompt: [
        '你是因果小说的章后事实提交器。只提交正文实际发生且可逐字举证的变化。',
        '禁止把原决策卡中的计划当成已发生事实；正文没有发生就不能提交。',
        '禁止输出关系评分、关系阶段或把情绪变化伪装成世界事实。',
        'evidenceQuotes、actorUpdates.evidence、pressureUpdates.evidence 必须逐字摘自正文。',
        'emotionalOutcome 只记录本章已经挣得的情绪结果；trigger/choice/cost/residue 四项 evidence 都必须逐字摘自正文。',
        '情绪债只记录本章正文真正开启或兑现的内容，不能预告未来关系路线。'
      ].join('\n'),
      prompt: [
        `【提交前权威状态】\n${JSON.stringify(state, null, 2)}`,
        `【本章决策】\n${JSON.stringify(record.plan.decision, null, 2)}`,
        `【本章情绪事务】\n${JSON.stringify(record.plan.emotionContract, null, 2)}`,
        `【本章正文】\n${chapter.content}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) throw new Error(response.error || '因果结果提取失败')
  onProgress?.('状态提取 3/3：正在校验证据、承诺、人物、压力与情绪结果')
  const outcome = parseStructured<CausalChapterOutcome>(response.content)
  const ordinal = volumeChapterDAO.listChaptersByWork(workId).findIndex(item => item.id === chapterId) + 1
  const nextState = applyCausalChapterOutcome(state, outcome, ordinal, chapter.content)
  return { state: nextState, outcome }
}

export async function extractAndCommitCausalOutcome(
  workId: number,
  chapterId: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ state: CausalNarrativeState; outcome: CausalChapterOutcome }> {
  const result = await extractCausalOutcome(workId, chapterId, signal, onProgress)
  const expectedStateRevision = result.state.revision - 1
  onProgress?.('正在原子提交章节因果结果与权威状态修订')
  causalNovelDAO.commitDecision({
    workId, chapterId, expectedStateRevision, nextState: result.state, outcome: result.outcome
  })
  return result
}
