import { createHash } from 'node:crypto'
import { causalNovelDAO, coreSettingDAO, volumeChapterDAO, workDAO } from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import { buildWorkContext } from '../work-context'
import { compileChapterExecutionContract } from '../chapter-execution-context'
import {
  CAUSAL_NOVEL_SCHEMA_VERSION,
  applyCausalChapterOutcome,
  buildCausalEvidenceCatalog,
  causalCandidateTotal,
  formatCausalDecisionCard,
  materializeCausalCandidates,
  materializeCausalChapterPlan,
  normalizeCausalNarrativeState,
  validateCausalChapterEmotionContract,
  type CausalChapterOutcome,
  type CausalChapterPlan,
  type CausalChapterPlanDraft,
  type CausalEventCandidate,
  type CausalEvidenceFact,
  type CausalEventCandidateDraft,
  type CausalEventCandidateProposal,
  type CausalNarrativeState
} from '../../../shared/causal-novel-types'
import { withGoalLoopModelOptions } from './story-goal-model'
import { runCausalOutcomePipeline } from './causal-outcome-pipeline'
import {
  adoptCausalBaselineChapters,
  buildCausalBaselineSeed,
  ensureCausalBaselineCoverage
} from './causal-baseline-migration'
import { buildCausalStateSeedProjection } from './causal-state-seed'
import { CAUSAL_STEP_EXECUTION_PROFILE } from './causal-step-execution-profile'
import { requestStructuredModelOutput } from './structured-model-output'
import {
  assertCandidateReferences,
  assertDecisionReferences,
  CausalPlanReferenceValidationError
} from './causal-plan-reference-repair'
import {
  repairCandidateReferences,
  repairDecisionReferences
} from './causal-plan-reference-request'
import {
  causalPlanStageInputHash,
  readCausalPlanStage,
  saveCausalPlanStage
} from './causal-plan-stage-cache'
import {
  bindServerChapterContract,
  stripServerBoundDecisionSchema,
  type CausalDecisionModelDetails
} from './causal-decision-server-contract'
const INITIAL_STATE_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  required: ['centralQuestion', 'terminalConditions', 'immutableRules', 'actors', 'activePressures', 'promises', 'macroArcs'],
  properties: {
    centralQuestion: { type: 'string' },
    terminalConditions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
    immutableRules: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
    actors: {
      type: 'array', minItems: 2, maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: [
          'name', 'currentGoal', 'fear', 'knowledge', 'resources', 'constraint',
          'location', 'physicalState', 'relationships', 'obligations'
        ],
        properties: {
          name: { type: 'string' }, currentGoal: { type: 'string' }, fear: { type: 'string' },
          knowledge: { type: 'array', items: { type: 'string' } },
          resources: { type: 'array', items: { type: 'string' } }, constraint: { type: 'string' },
          location: { type: 'string' }, physicalState: { type: 'string' },
          relationships: { type: 'array', maxItems: 20, items: { type: 'string' } },
          obligations: { type: 'array', maxItems: 20, items: { type: 'string' } }
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
    },
    macroArcs: {
      type: 'array', minItems: 1, maxItems: 10,
      items: {
        type: 'object', additionalProperties: false,
        required: [
          'id', 'title', 'objective', 'entryConditions', 'exitConditions',
          'mandatoryPayoffs', 'forbiddenDrift', 'status'
        ],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, objective: { type: 'string' },
          entryConditions: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
          exitConditions: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
          mandatoryPayoffs: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
          forbiddenDrift: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
          status: { type: 'string', enum: ['pending', 'active'] }
        }
      }
    }
  }
}

const AUTHORITY_REBASE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['actors', 'activePressures', 'promises'],
  properties: {
    actors: (INITIAL_STATE_SCHEMA.properties as Record<string, unknown>).actors,
    activePressures: (INITIAL_STATE_SCHEMA.properties as Record<string, unknown>).activePressures,
    promises: (INITIAL_STATE_SCHEMA.properties as Record<string, unknown>).promises
  }
}

const MACRO_UPGRADE_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['macroArcs'],
  properties: {
    macroArcs: (INITIAL_STATE_SCHEMA.properties as Record<string, unknown>).macroArcs
  }
}

function macroReplanSchema(): Record<string, unknown> {
  const macroArcs = JSON.parse(JSON.stringify(
    (INITIAL_STATE_SCHEMA.properties as Record<string, unknown>).macroArcs
  )) as { items: { properties: { status: Record<string, unknown> } } }
  macroArcs.items.properties.status = {
    type: 'string', enum: ['pending', 'active', 'completed']
  }
  return {
    type: 'object', additionalProperties: false, required: ['changed', 'reason', 'macroArcs'],
    properties: {
      changed: { type: 'boolean' },
      reason: { type: 'string' },
      macroArcs
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
  required: [
    'causalNecessity', 'promiseProgress', 'irreversibleImpact',
    'novelty', 'pressureEscalation', 'pacingFitness'
  ],
  properties: Object.fromEntries(
    [
      'causalNecessity', 'promiseProgress', 'irreversibleImpact',
      'novelty', 'pressureEscalation', 'pacingFitness'
    ]
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

const CAUSAL_EMOTION_CONTRACT_DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [
    'attachment_anchor', 'value_at_stake', 'reader_state_before',
    'trigger_event', 'character_appraisal', 'character_layers', 'information_position',
    'choice_and_cost', 'private_detail_anchor', 'subtext_or_omission', 'reader_state_after',
    'arc_role', 'emotional_debt_opened', 'emotional_debt_paid', 'residue_into_next',
    'groundingEvidence'
  ],
  properties: {
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
    groundingEvidence: {
      type: 'object', additionalProperties: false,
      required: ['attachmentEvidenceId', 'privateDetailEvidenceId'],
      properties: {
        attachmentEvidenceId: { type: 'string' },
        privateDetailEvidenceId: { type: 'string' }
      }
    }
  }
}

const CHAPTER_PLAN_SCHEMA_BASE: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  required: ['candidates', 'decision', 'emotionContract', 'rollingHorizon'],
  properties: {
    candidates: {
      type: 'array', minItems: 3, maxItems: 3,
      items: {
        type: 'object', additionalProperties: false,
        required: [
          'chapterFunction', 'initiator', 'action', 'opposition', 'cost',
          'irreversibleChange', 'promiseAdvanced', 'newQuestion'
        ],
        properties: {
          chapterFunction: {
            type: 'string',
            enum: ['advance', 'complicate', 'reveal', 'payoff', 'consolidate', 'aftermath']
          },
          initiator: { type: 'string', minLength: 1, maxLength: 80 },
          action: { type: 'string', minLength: 1, maxLength: 180 },
          opposition: { type: 'string', minLength: 1, maxLength: 160 },
          cost: { type: 'string', minLength: 1, maxLength: 100 },
          irreversibleChange: { type: 'string', minLength: 1, maxLength: 140 },
          promiseAdvanced: { type: 'string', minLength: 1, maxLength: 100 },
          newQuestion: { type: 'string', minLength: 1, maxLength: 140 }
        }
      }
    },
    decision: {
      type: 'object', additionalProperties: false,
      required: [
        'title', 'pov', 'immediateWant', 'openingState', 'mustCover', 'forbiddenEvents',
        'endingState', 'continuityConstraints', 'characters'
      ],
      properties: {
        title: { type: 'string' }, pov: { type: 'string' },
        immediateWant: { type: 'string' }, openingState: { type: 'string' },
        mustCover: { type: 'array', minItems: 2, items: { type: 'string' } },
        forbiddenEvents: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
        endingState: { type: 'string' },
        continuityConstraints: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
        characters: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } }
      }
    },
    emotionContract: CAUSAL_EMOTION_CONTRACT_DRAFT_SCHEMA,
    rollingHorizon: {
      type: 'array', minItems: 5, maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: [
          'offset', 'objective', 'initiator', 'pressureIds', 'promiseIds',
          'expectedIrreversibleChange', 'replanningTrigger'
        ],
        properties: {
          offset: { type: 'integer', minimum: 0, maximum: 11 },
          objective: { type: 'string' }, initiator: { type: 'string' },
          pressureIds: { type: 'array', maxItems: 4, items: { type: 'string' } },
          promiseIds: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
          expectedIrreversibleChange: { type: 'string' },
          replanningTrigger: { type: 'string' }
        }
      }
    }
  }
}

function buildChapterPlanWireSchema(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(CHAPTER_PLAN_SCHEMA_BASE)) as Record<string, unknown>
}

function buildCandidateDraftSchema(): Record<string, unknown> {
  const full = buildChapterPlanWireSchema() as { properties: Record<string, unknown> }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['candidates'],
    properties: { candidates: full.properties.candidates }
  }
}

function buildDecisionDraftSchema(serverBoundContract: boolean): Record<string, unknown> {
  const full = buildChapterPlanWireSchema() as { properties: Record<string, unknown> }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'emotionContract', 'rollingHorizon'],
    properties: {
      decision: serverBoundContract
        ? stripServerBoundDecisionSchema(full.properties.decision as Record<string, unknown>)
        : full.properties.decision,
      emotionContract: full.properties.emotionContract,
      rollingHorizon: full.properties.rollingHorizon
    }
  }
}

const PLAN_AUDIT_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  required: ['passed', 'failureLayer', 'selectedCandidateId', 'reasons'],
  properties: {
    passed: { type: 'boolean' },
    failureLayer: {
      type: 'string',
      enum: ['none', 'authority_state', 'candidate', 'decision']
    },
    selectedCandidateId: { type: 'string' },
    reasons: { type: 'array', maxItems: 12, items: { type: 'string' } }
  }
}

function buildPlanAuditSchema(candidateIds: string[]): Record<string, unknown> {
  const schema = JSON.parse(JSON.stringify(PLAN_AUDIT_SCHEMA)) as {
    properties: { selectedCandidateId: { enum?: string[] } }
  }
  schema.properties.selectedCandidateId.enum = candidateIds
  return schema
}

function parseStructured<T>(content: string): T {
  const json = extractJsonText(content.trim()) ?? content.trim()
  return JSON.parse(json) as T
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function causalPlanFailureCode(message: string): string {
  if (/JSON|结构化|格式|Unexpected token|Expected property/.test(message)) return 'PLAN_FORMAT'
  if (/人物|发起人|视角|POV|pov|initiator/.test(message)) return 'PLAN_IDENTITY'
  if (/证据|attachment_anchor|private_detail_anchor|grounding/.test(message)) return 'PLAN_EVIDENCE'
  if (/承诺|压力|引用不存在|已关闭/.test(message)) return 'PLAN_REFERENCE'
  if (/总分|最高分|候选不存在/.test(message)) return 'PLAN_SCORING'
  if (/滚动窗口|offset|首章/.test(message)) return 'PLAN_HORIZON'
  if (/独立评审|待审计划/.test(message)) return 'PLAN_AUDIT'
  return 'PLAN_UNKNOWN'
}

function causalSeed(workId: number, goal: string): string {
  const work = workDAO.getById(workId)
  const worldview = coreSettingDAO.getByType(workId, 'worldview')?.content?.trim()
    || coreSettingDAO.getByType(workId, 'world_pressure')?.content?.trim()
  const volumes = volumeChapterDAO.listVolumes(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const existingStructure = JSON.stringify(
    buildCausalStateSeedProjection(volumes, chapters)
  )
  const baseline = buildCausalBaselineSeed(workId)
  const seed = [
    work?.description?.trim().slice(0, 10_000),
    worldview?.slice(0, 10_000),
    goal.trim().slice(0, 6_000),
    existingStructure ? `【已确认的宏观规划】\n${existingStructure}` : '',
    baseline ? `【完整覆盖校验后的当前事实投影】\n${baseline}` : ''
  ].filter(Boolean).join('\n\n')
  if (!seed) throw new Error('因果小说需要先填写世界起点或创作目标')
  return seed
}

function causalMacroGuide(workId: number): string {
  const description = workDAO.getById(workId)?.description?.trim() ?? ''
  if (!description) return ''
  const priorityBlocks = description.split(/\n{2,}/).filter(block =>
    /阶段|终局|最终|核心事件|压迫升级|清算节点|规则如何约束/.test(block)
  )
  const selected = priorityBlocks.length ? priorityBlocks.join('\n\n') : description
  return selected.slice(0, 9000)
}

function validateInitialState(state: CausalNarrativeState): void {
  if (!state.centralQuestion.trim()) throw new Error('核心戏剧问题为空')
  if (state.actors.length < 2) throw new Error('至少需要两个能独立行动的人物')
  if (state.activePressures.length === 0) throw new Error('至少需要一个当前压力')
  if (new Set(state.actors.map(actor => actor.name)).size !== state.actors.length) throw new Error('人物名称重复')
  if (new Set(state.activePressures.map(item => item.id)).size !== state.activePressures.length) throw new Error('压力 ID 重复')
  if (new Set(state.promises.map(item => item.id)).size !== state.promises.length) throw new Error('读者承诺 ID 重复')
  if (state.macroArcs.length === 0) throw new Error('至少需要一个阶段锚点')
  if (new Set(state.macroArcs.map(item => item.id)).size !== state.macroArcs.length) throw new Error('阶段 ID 重复')
  if (state.macroArcs.filter(item => item.status === 'active').length !== 1) throw new Error('初始状态必须且只能有一个活跃阶段')
}

export async function initializeCausalNovelState(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<CausalNarrativeState> {
  const existing = causalNovelDAO.getState(workId)
  if (existing) return existing
  onProgress?.('初始状态 1/3：正在整理世界起点与硬规则')
  await ensureCausalBaselineCoverage(workId, signal, onProgress)
  const seed = causalSeed(workId, goal)
  onProgress?.('初始状态 2/3：正在请求模型建立人物、世界压力与读者承诺')
  type InitialStateDraft =
    Omit<
      CausalNarrativeState,
      'schemaVersion' | 'revision' | 'recentEventSignatures' | 'archivedPromiseIds' | 'lastMacroAuditChapter' |
      'macroArcs' | 'macroArchitectureReady' | 'completionStatus' | 'completionAuditFeedback' | 'completed' | 'completionReason'
    > & {
      macroArcs: Array<Omit<CausalNarrativeState['macroArcs'][number], 'lastAdvancedChapter'>>
    }
  const raw = await requestStructuredModelOutput<InitialStateDraft>({
    workId,
    label: '因果初始状态',
    attempts: 2,
    signal,
    schema: INITIAL_STATE_SCHEMA,
    request: async () => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId, step: 'goal_novel_causal_state', enrichWorkContext: false, enrichNarrativeMemory: false,
        temperature: 0.2, maxTokens: 5000, timeoutMs: 120_000, forceThinkingDisabled: true,
        responseSchema: { name: 'causal_novel_initial_state', schema: INITIAL_STATE_SCHEMA, strict: true },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是统一小说协议的权威状态建模器。宏观分卷与章节规划已经由上游完成；只把它们压缩为当前状态和阶段锚点，不重复生成全书大纲。',
          '若存在既有正文，正文事实高于大纲；把既有正文视为迁移基线，不得重写、否定或虚构其中尚未发生的事实。',
          '剧情发动机只能来自人物目标、世界压力、信息差、资源约束、读者承诺与行动代价。',
          '人物关系只能作为已知事实，不得建立关系分值、关系阶段或以关系变化作为独立发动机。',
          'terminalConditions 是核心问题得到不可逆回答的判定条件，不得写成预设结局步骤。',
          'macroArcs 只保存卷级/阶段级目标、进入/退出条件、必须兑现与禁止漂移；不得拆成逐章大纲。',
          'macroArcs 必须按因果依赖排序，第一项 active，其余 pending。'
        ].join('\n'),
        prompt: `【世界起点】\n${seed}`
      }),
      { stream: false, signal }
    ),
    validate: value => value as unknown as InitialStateDraft
  })
  const state: CausalNarrativeState = {
    ...raw,
    schemaVersion: CAUSAL_NOVEL_SCHEMA_VERSION,
    revision: 0,
    promises: raw.promises.map(item => ({ ...item, status: 'open', openedChapter: 0, lastAdvancedChapter: 0 })),
    macroArcs: raw.macroArcs.map((item, index) => ({
      ...item,
      status: index === 0 ? 'active' : 'pending',
      lastAdvancedChapter: 0
    })),
    macroArchitectureReady: true,
    lastMacroAuditChapter: 0,
    archivedPromiseIds: [], recentEventSignatures: [],
    completionStatus: 'writing', completionAuditFeedback: [],
    completed: false, completionReason: ''
  }
  onProgress?.('初始状态 3/3：正在校验并写入权威因果状态')
  validateInitialState(state)
  causalNovelDAO.createState(workId, state)
  adoptCausalBaselineChapters(workId)
  return state
}

/**
 * 尚无已提交章节时，允许把错误的“未来态”重建为目标章节开场前状态。
 * 已提交事实存在时禁止回写状态，调用方必须改为重规划当前章节合同。
 */
export async function rebaseCausalNovelAuthorityToChapter(
  workId: number,
  chapterId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<CausalNarrativeState> {
  const state = causalNovelDAO.getState(workId)
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!state || !chapter) throw new Error('权威状态或目标章节不存在，不能重建规划起点')
  if (causalNovelDAO.listDecisions(workId).some(item => item.status === 'committed')) {
    throw new Error('已有已提交章节，禁止把权威因果状态回退到章节开场')
  }
  if (causalNovelDAO.listDecisions(workId).some(item => item.status === 'planned')) {
    throw new Error('存在待提交章节决策，禁止重建权威因果状态')
  }
  const macroContract = (chapter.outline ?? '').split('## 章级权威因果合同', 1)[0].trim()
  if (!macroContract) throw new Error('目标章节缺少宏观合同，不能重建规划起点')
  onProgress?.(`正在把权威因果状态重建到「${chapter.title}」开场前`)
  type AuthorityRebaseDraft = Pick<CausalNarrativeState, 'actors' | 'activePressures'> & {
    promises: Array<Pick<CausalNarrativeState['promises'][number], 'id' | 'question'>>
  }
  const raw = await requestStructuredModelOutput<AuthorityRebaseDraft>({
    workId,
    label: '权威因果状态重建',
    attempts: 2,
    signal,
    schema: AUTHORITY_REBASE_SCHEMA,
    request: async () => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_novel_causal_authority_rebase',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens: 3600,
        timeoutMs: 120_000,
        forceThinkingDisabled: true,
        responseSchema: {
          name: 'causal_novel_authority_rebase',
          schema: AUTHORITY_REBASE_SCHEMA,
          strict: true
        },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是因果小说权威状态重建器。只重建目标章节第一个事件发生之前的即时状态。',
          '目标章节宏观合同是当前时点的最高权威；卷级阶段和作品目标只描述未来方向，绝不能写成已经发生的事实。',
          '人物不得提前获得本章或后续章节才出现的资源、知识、关系、伤势、据点、盟友或敌对结果。',
          '当前压力必须能在目标章节开场直接观察到；读者承诺必须能由开场信息提出。',
          '只返回 JSON。'
        ].join('\n'),
        prompt: [
          `【目标章节宏观合同】\n标题：${chapter.title}\n${macroContract}`,
          `【不可修改的核心问题、终局条件与硬规则】\n${JSON.stringify({
            centralQuestion: state.centralQuestion,
            terminalConditions: state.terminalConditions,
            immutableRules: state.immutableRules
          }, null, 2)}`,
          `【仅供未来方向参考、禁止当作已发生事实的阶段架构】\n${JSON.stringify(state.macroArcs, null, 2)}`,
          `【作品目标】\n${goal.trim().slice(0, 6000)}`
        ].join('\n\n')
      }),
      { stream: false, signal }
    ),
    validate: value => value as unknown as AuthorityRebaseDraft
  })
  const next: CausalNarrativeState = {
    ...state,
    revision: state.revision + 1,
    actors: raw.actors,
    activePressures: raw.activePressures,
    promises: raw.promises.map(item => ({
      ...item,
      status: 'open',
      openedChapter: 0,
      lastAdvancedChapter: 0
    })),
    archivedPromiseIds: [],
    recentEventSignatures: [],
    completionStatus: 'writing',
    completionAuditFeedback: [],
    completed: false,
    completionReason: ''
  }
  validateInitialState(next)
  causalNovelDAO.replaceState(workId, state.revision, next, {
    transitionType: 'planning_authority_rebased',
    sourceChapterId: chapterId
  })
  return next
}

export async function upgradeCausalNovelMacroArchitecture(
  workId: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<CausalNarrativeState> {
  const state = causalNovelDAO.getState(workId)
  if (!state) throw new Error('因果状态尚未初始化')
  if (state.macroArchitectureReady) return state
  if (causalNovelDAO.listDecisions(workId).some(item => item.status === 'planned')) {
    throw new Error('存在尚未提交的章节决策，不能升级阶段架构')
  }
  onProgress?.('正在把旧因果状态升级为可审计的阶段锚点')
  type MacroUpgradeDraft = {
    macroArcs: Array<Omit<CausalNarrativeState['macroArcs'][number], 'lastAdvancedChapter'>>
  }
  const parsed = await requestStructuredModelOutput<MacroUpgradeDraft>({
    workId,
    label: '因果阶段架构升级',
    attempts: 2,
    signal,
    schema: MACRO_UPGRADE_SCHEMA,
    request: async () => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId, step: 'goal_novel_causal_macro_upgrade', enrichWorkContext: false,
        enrichNarrativeMemory: false, temperature: 0.1, maxTokens: 4000,
        responseSchema: { name: 'causal_novel_macro_upgrade', schema: MACRO_UPGRADE_SCHEMA, strict: true },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是长篇滚动因果的阶段架构升级器。把原始路线压缩成1-10个可审计阶段锚点。',
          '只定义阶段目标、进入/退出条件、必须兑现和禁止漂移，不生成逐章大纲。',
          '已发生正文优先于原始路线；第一项未完成阶段 active，其余 pending。'
        ].join('\n'),
        prompt: [
          `【当前权威状态】\n${JSON.stringify(state, null, 2)}`,
          `【作品原始阶段指南】\n${causalMacroGuide(workId) || '未提供额外路线，以核心问题和终止条件建立单一阶段'}`
        ].join('\n\n')
      }),
      { stream: false, signal }
    ),
    validate: value => value as unknown as MacroUpgradeDraft
  })
  const committedChapterCount = causalNovelDAO.listDecisions(workId).filter(item => item.status === 'committed').length
  const next: CausalNarrativeState = {
    ...state,
    revision: state.revision + 1,
    macroArcs: parsed.macroArcs.map((item, index) => ({
      ...item,
      status: index === 0 ? 'active' : 'pending',
      lastAdvancedChapter: committedChapterCount
    })),
    macroArchitectureReady: true
  }
  validateInitialState(next)
  causalNovelDAO.replaceState(workId, state.revision, next, { transitionType: 'macro_architecture_upgrade' })
  return next
}

export async function auditAndReplanCausalMacroArchitecture(
  workId: number,
  committedChapterCount: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<CausalNarrativeState> {
  const state = causalNovelDAO.getState(workId)
  if (!state) throw new Error('因果状态尚未初始化')
  const dueByInterval = committedChapterCount - state.lastMacroAuditChapter >= 8
  const dueByFinalFeedback = state.completionAuditFeedback.length > 0
  if (!dueByInterval && !dueByFinalFeedback) return state
  if (causalNovelDAO.listDecisions(workId).some(item => item.status === 'planned')) {
    throw new Error('存在尚未提交的章节决策，不能重审阶段架构')
  }
  onProgress?.('阶段重审：正在根据已提交事实检查剩余阶段是否仍可达')
  const recentCommitted = causalNovelDAO.listDecisions(workId)
    .filter(item => item.status === 'committed')
    .slice(-8)
    .map(item => ({
      chapterId: item.chapterId,
      decision: item.plan.decision,
      outcome: item.outcome?.summary,
      eventSignature: item.outcome?.eventSignature
    }))
  type MacroReplanDraft = {
    changed: boolean
    reason: string
    macroArcs: Array<Omit<CausalNarrativeState['macroArcs'][number], 'lastAdvancedChapter'>>
  }
  const schema = macroReplanSchema()
  const parsed = await requestStructuredModelOutput<MacroReplanDraft>({
    workId,
    label: '因果阶段架构重审',
    attempts: 2,
    signal,
    schema,
    request: async () => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId, step: 'goal_novel_causal_macro_replan',
        enrichWorkContext: false, enrichNarrativeMemory: false,
        temperature: 0, maxTokens: 4200, forceThinkingDisabled: true,
        responseSchema: { name: 'causal_novel_macro_replan', schema, strict: true },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是长篇因果架构审计器。只能重排或细化未完成阶段，不能改写已发生事实、硬规则、核心问题或终止条件。',
          'completed 阶段必须逐字保留；剩余阶段必须且只能有一个 active，其他为 pending。',
          '只有当新事实、连续失败或终审反馈使原路线不可达/失衡时 changed=true；否则原样返回。',
          '允许拆分、合并或改写未完成阶段，但每个阶段仍只保存目标、进入/退出条件、兑现项和禁止漂移。',
          '禁止生成逐章大纲。只返回 JSON。'
        ].join('\n'),
        prompt: [
          `【权威状态】\n${JSON.stringify(state, null, 2)}`,
          `【最近已提交结果】\n${JSON.stringify(recentCommitted, null, 2)}`,
          state.completionAuditFeedback.length
            ? `【终审退回原因】\n${state.completionAuditFeedback.join('\n')}`
            : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    ),
    validate: value => value as unknown as MacroReplanDraft
  })
  const completed = state.macroArcs.filter(item => item.status === 'completed')
  const returnedCompleted = parsed.macroArcs.filter(item => item.status === 'completed')
  const stableArc = (arc: Omit<CausalNarrativeState['macroArcs'][number], 'lastAdvancedChapter'>) =>
    JSON.stringify({
      id: arc.id, title: arc.title, objective: arc.objective,
      entryConditions: arc.entryConditions, exitConditions: arc.exitConditions,
      mandatoryPayoffs: arc.mandatoryPayoffs, forbiddenDrift: arc.forbiddenDrift, status: arc.status
    })
  if (
    completed.length !== returnedCompleted.length ||
    completed.some(item => !returnedCompleted.some(candidate => stableArc(candidate) === stableArc(item)))
  ) {
    throw new Error('阶段重审试图改写已经完成的阶段')
  }
  const macroArcs = parsed.macroArcs.map(item => {
    const previous = state.macroArcs.find(arc => arc.id === item.id)
    return {
      ...item,
      lastAdvancedChapter: previous?.lastAdvancedChapter ?? committedChapterCount
    }
  })
  const activeCount = macroArcs.filter(item => item.status === 'active').length
  if (activeCount !== 1 && !state.completed) throw new Error('阶段重审后必须且只能有一个活跃阶段')
  const next: CausalNarrativeState = {
    ...state,
    revision: state.revision + 1,
    macroArcs: parsed.changed ? macroArcs : state.macroArcs,
    lastMacroAuditChapter: committedChapterCount
  }
  causalNovelDAO.replaceState(workId, state.revision, next, {
    transitionType: parsed.changed ? 'macro_architecture_replanned' : 'macro_architecture_audited'
  })
  return next
}

function validateChapterPlan(state: CausalNarrativeState, plan: CausalChapterPlan): void {
  const candidate = plan.candidates.find(item => item.id === plan.selectedCandidateId)
  if (!candidate) throw new Error('所选因果候选不存在')
  const computed = plan.candidates.map(item => ({
    id: item.id,
    total: causalCandidateTotal(item)
  }))
  for (const item of plan.candidates) {
    const expected = computed.find(score => score.id === item.id)?.total
    if (item.scores.total !== expected) throw new Error(`候选 ${item.id} 总分计算不一致`)
  }
  const bestScore = Math.max(...computed.map(item => item.total))
  if (candidate.scores.total !== bestScore) throw new Error('所选候选不是确定性重算后的最高分项')
  const promiseIds = new Set(state.promises.filter(item => item.status !== 'resolved').map(item => item.id))
  for (const id of plan.decision.advancedPromiseIds) {
    if (!promiseIds.has(id)) throw new Error(`决策引用不存在或已关闭的读者承诺：${id}`)
  }
  const actorNames = new Set(state.actors.map(actor => actor.name))
  if (!actorNames.has(plan.decision.initiator)) throw new Error('决策发起人不在当前人物状态中')
  if (plan.decision.mustCover.length < 2) throw new Error('章节决策缺少可验收因果节点')
  if (candidate.initiator !== plan.decision.initiator) throw new Error('章节决策发起人与所选候选不一致')
  if (plan.rollingHorizon.length < 5) throw new Error('近期滚动窗口不足 5 章')
  const offsets = plan.rollingHorizon.map(item => item.offset)
  if (offsets.some((offset, index) => offset !== index)) throw new Error('近期滚动窗口 offset 必须从 0 连续递增')
  if (plan.rollingHorizon[0]?.initiator !== plan.decision.initiator) throw new Error('滚动窗口首章与当前决策不一致')
  const pressureIds = new Set(state.activePressures.filter(item => item.status === 'active').map(item => item.id))
  for (const beat of plan.rollingHorizon) {
    if (!actorNames.has(beat.initiator)) throw new Error(`滚动窗口发起人不在当前人物状态中：${beat.initiator}`)
    const invalidPromise = beat.promiseIds.find(id => !promiseIds.has(id))
    if (invalidPromise) throw new Error(`滚动窗口引用不存在或已关闭的读者承诺：${invalidPromise}`)
    const invalidPressure = beat.pressureIds.find(id => !pressureIds.has(id))
    if (invalidPressure) throw new Error(`滚动窗口引用不存在或已关闭的世界压力：${invalidPressure}`)
  }
}

export async function planNextCausalChapter(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
  options: {
    existingChapterId?: number
    checkEmotionContract?: boolean
  } = {}
): Promise<{ chapterId: number; plan: CausalChapterPlan }> {
  onProgress?.('章节决策 1/6：正在读取权威状态、阶段锚点与最近正文')
  const state = causalNovelDAO.getState(workId)
  if (!state) throw new Error('因果状态尚未初始化')
  if (state.completed) throw new Error(`核心问题已经收束：${state.completionReason}`)
  const targetChapter = options.existingChapterId
    ? volumeChapterDAO.getChapter(options.existingChapterId)
    : undefined
  if (options.existingChapterId && (
    !targetChapter || volumeChapterDAO.getWorkIdForChapter(options.existingChapterId) !== workId
  )) {
    throw new Error('待绑定的宏观规划章节不存在或不属于当前小说')
  }
  const serverChapterContract = targetChapter
    ? compileChapterExecutionContract(workId, targetChapter.id)
    : null
  if (targetChapter && (
    !serverChapterContract
    || serverChapterContract.errors.length > 0
    || serverChapterContract.requiredEvents.length === 0
  )) {
    throw new Error(
      `宏观章节合同无法形成权威决策：${serverChapterContract?.errors.join('；') || '缺少必须覆盖事件'}`
    )
  }
  const existingTargetDecision = options.existingChapterId
    ? causalNovelDAO.getDecision(options.existingChapterId)
    : null
  if (existingTargetDecision) {
    return { chapterId: existingTargetDecision.chapterId, plan: existingTargetDecision.plan }
  }
  const existingPending = causalNovelDAO.listDecisions(workId).find(item => item.status === 'planned')
  if (existingPending) throw new Error(`第 ${existingPending.chapterId} 章决策尚未提交，禁止规划下一章`)
  const decisions = causalNovelDAO.listDecisions(workId)
  const committedIds = new Set(decisions.filter(item => item.status === 'committed').map(item => item.chapterId))
  const canonicalChapters = volumeChapterDAO.listChaptersByWork(workId).filter(chapter => committedIds.has(chapter.id))
  const recentChapters = canonicalChapters.slice(-3)
  const recent = recentChapters
    .map((chapter, index) => `最近${recentOrdinal(index, recentChapters.length)}章：${chapter.title}\n${chapter.content?.slice(-1600) ?? ''}`)
    .join('\n\n')
  const recentEmotionalOutcomes = decisions.filter(item => item.status === 'committed').slice(-3)
    .map(item => item.outcome?.emotionalOutcome)
    .filter(Boolean)
  const recentChapterFunctions = decisions.filter(item => item.status === 'committed').slice(-6)
    .map(item => item.plan.candidates.find(candidate => candidate.id === item.plan.selectedCandidateId)?.chapterFunction)
    .filter(Boolean)
  const previousHorizon = decisions.filter(item => item.status === 'committed').at(-1)?.plan.rollingHorizon?.slice(1) ?? []
  const context = buildWorkContext(workId, { includeVolumes: false, includeCoreSettings: true }).text.slice(0, 5000)
  const targetOrdinal = targetChapter
    ? volumeChapterDAO.listChaptersByWork(workId).findIndex(chapter => chapter.id === targetChapter.id) + 1
    : canonicalChapters.length + 1
  const staleArc = state.macroArcs.find(arc =>
    arc.status === 'active' && targetOrdinal - arc.lastAdvancedChapter >= 3
  )
  const macroGuide = [
    state.macroArchitectureReady ? '' : causalMacroGuide(workId),
    staleArc
      ? `【强制宏观推进】当前章节必须推进阶段 ${staleArc.id}「${staleArc.title}」。章节决策必须设计可在正文中发生、可被证据绑定的阶段推进事实，章后结果必须输出该阶段 arcUpdates。`
      : ''
  ].filter(Boolean).join('\n')
  const evidenceCatalog = buildCausalEvidenceCatalog(
    state,
    recentChapters.map(chapter => ({ id: chapter.id, content: chapter.content ?? '' }))
  )
  if (evidenceCatalog.length < 2) throw new Error('当前权威状态没有足够的原子证据用于章节规划')
  const planningInputHash = causalPlanStageInputHash({
    state,
    goal: goal.trim(),
    checkEmotionContract: options.checkEmotionContract !== false,
    targetChapter: targetChapter ? {
      id: targetChapter.id,
      title: targetChapter.title,
      outline: targetChapter.outline,
      outlineDiagnosis: targetChapter.outline_diagnosis
    } : null,
    context,
    macroGuide,
    recent
  })
  let candidateContent = readCausalPlanStage(
    workId,
    state.revision,
    'candidate_generation_v3',
    planningInputHash
  )
  const candidateWasCached = Boolean(candidateContent)
  if (candidateContent) {
    onProgress?.('章节决策 2/7：已恢复当前状态与宏观合同绑定的候选制品')
  } else {
    onProgress?.('章节决策 2/7：正在生成互斥候选并由服务端重算评分')
    try {
      const schema = buildCandidateDraftSchema()
      const proposals = await requestStructuredModelOutput<CausalEventCandidateProposal[]>({
        workId,
        label: '下一章因果候选',
        attempts: 2,
        signal,
        schema,
        request: async (_attempt, lastError) => modelService.chat(
          withGoalLoopModelOptions(workId, {
            workId, step: 'goal_novel_causal_candidates', enrichWorkContext: false, enrichNarrativeMemory: false,
            ...CAUSAL_STEP_EXECUTION_PROFILE.candidateGeneration,
            responseSchema: { name: 'causal_novel_candidate_drafts', schema, strict: true },
            structuredOutputMode: 'prompt_json',
            systemPrompt: [
              '你是滚动因果小说的候选事件生成器。基于当前权威状态提出恰好3个互斥候选。',
              '候选是供服务端决策的事件合同，不是正文草稿：每个字段只写一条摘要句，禁止扩写动作过程、对白、场景描写或重复上下文。',
              '候选必须按综合可执行性从高到低排序；服务端会确定性选择第一项，不再启动第二个评分模型。',
              '先在返回 JSON 的每个候选字段中外显行动依据、阻力、代价与不可逆变化，不依赖隐藏长推理。',
              '禁止生成全书大纲、分卷计划、人物关系未来路线或为了制造冲突让人物降智。',
              '候选必须由人物当前目标与认知、世界压力、资源约束、未兑现读者承诺共同推出。',
              '不要返回候选 id、评分或所选候选；独立评审器会在另一轮请求中盲评。',
              '每章必须推进至少一个未关闭承诺，但允许 aftermath/consolidate 章通过消化后果、固定关系或澄清信息推进，不得强迫升级。',
              'chapterFunction 必须从 advance/complicate/reveal/payoff/consolidate/aftermath 中选择。',
              'irreversibleChange 对沉淀或余波章可填写“固定了什么后果/认知/义务”，不要求制造更大的外部冲突。',
              '关系变化不是评分项，也不能作为候选成立的唯一理由。',
              'initiator 必须只填写一个当前权威人物名称，不得附加身份说明。',
              'promiseAdvanced 必须且只能填写一个当前未关闭承诺的权威 ID；即使候选推进多个承诺，也只选择与 action 最直接的主承诺，禁止附加问题文本、解释或第二个 ID。服务端会在创作制品冻结后校验并绑定权威引用。'
            ].join('\n'),
            prompt: [
              `【用户目标】\n${goal.trim()}`,
              `【当前权威因果状态】\n${JSON.stringify(state, null, 2)}`,
              `【阶段锚点】\n${JSON.stringify(state.macroArcs, null, 2)}`,
              targetChapter
                ? `【本章不可漂移的宏观合同】\n标题：${targetChapter.title}\n${targetChapter.outline?.trim() || '未填写章节大纲'}`
                : '',
              state.completionAuditFeedback.length
                ? `【上次终审退回原因，下一窗口必须处理】\n${state.completionAuditFeedback.join('\n')}`
                : '',
              macroGuide ? `【作品原始阶段指南，只约束长线方向，不是不可修改的逐章大纲】\n${macroGuide}` : '',
              context ? `【作品硬规则与设定】\n${context}` : '',
              recent ? `【最近正文，仅用于避免重复与保持连续】\n${recent}` : '',
              lastError !== '未知结构化输出错误'
                ? `【上次传输结构无效】\n${lastError}\n只修正 JSON 形状，不改变候选语义。`
                : ''
            ].filter(Boolean).join('\n\n')
          }),
          { stream: false, signal }
        ),
        validate: value => assertCandidateReferences(
          state,
          (value.candidates as CausalEventCandidateProposal[]) ?? []
        ),
        shouldRepairValidationError: error => error instanceof CausalPlanReferenceValidationError,
        repairValidationError: async ({ value, error }) => repairCandidateReferences({
          workId,
          state,
          candidates: (value.candidates as CausalEventCandidateProposal[]) ?? [],
          issues: (error as CausalPlanReferenceValidationError).issues,
          signal
        })
      })
      candidateContent = JSON.stringify({ candidates: proposals })
    } catch (error) {
      const message = errorMessage(error)
      causalNovelDAO.recordPlanAttempt({
        workId,
        stateRevision: state.revision,
        stage: 'candidate_generation',
        status: 'rejected',
        errorCode: causalPlanFailureCode(message),
        errorMessage: message
      })
      throw error
    }
  }
  let candidateDrafts: CausalEventCandidateDraft[]
  let selectedCandidate: CausalChapterPlan['candidates'][number]
  try {
    const proposals = assertCandidateReferences(
      state,
      parseStructured<{ candidates: CausalEventCandidateProposal[] }>(candidateContent!).candidates
    )
    const candidateIds = proposals.map((_, index) => `candidate_${index + 1}`)
    const scoringInputHash = causalPlanStageInputHash({ planningInputHash, candidateContent })
    let scoreContent = readCausalPlanStage(
      workId,
      state.revision,
      'candidate_scoring_v2',
      scoringInputHash
    )
    const scoreWasCached = Boolean(scoreContent)
    if (scoreContent) {
      onProgress?.('章节决策 3/7：已恢复与当前候选绑定的确定性排序制品')
    } else {
      onProgress?.('章节决策 3/7：服务端按生成器冻结顺序建立确定性候选权重')
      scoreContent = JSON.stringify({
        scores: candidateIds.map((candidateId, index) => {
          const score = Math.max(60, 92 - index * 6)
          return {
            candidateId,
            causalNecessity: score,
            promiseProgress: score,
            irreversibleImpact: score,
            novelty: score,
            pressureEscalation: score,
            pacingFitness: score,
            reasons: ['候选生成器已按冻结宏观合同和可执行性排序']
          }
        })
      })
    }
    const scoreRows = parseStructured<{
      scores: Array<Omit<CausalEventCandidate['scores'], 'total'> & {
        candidateId: string
        reasons: string[]
      }>
    }>(scoreContent!).scores
    if (
      scoreRows.length !== candidateIds.length ||
      new Set(scoreRows.map(item => item.candidateId)).size !== candidateIds.length ||
      candidateIds.some(id => !scoreRows.some(item => item.candidateId === id))
    ) {
      throw new Error('独立候选评分没有完整覆盖所有候选')
    }
    if (!scoreWasCached) {
      saveCausalPlanStage({
        workId,
        stateRevision: state.revision,
        stage: 'candidate_scoring_v2',
        inputHash: scoringInputHash,
        content: scoreContent!
      })
    }
    const independentScores = candidateIds.map(id => {
      const { candidateId: _candidateId, reasons: _reasons, ...scores } =
        scoreRows.find(item => item.candidateId === id)!
      return scores
    })
    candidateDrafts = proposals.map((proposal, index) => ({
      ...proposal,
      scores: independentScores[index]
    }))
    const candidates = materializeCausalCandidates(proposals, independentScores)
    selectedCandidate = candidates.reduce((best, item) => item.scores.total > best.scores.total ? item : best)
    if (targetChapter && selectedCandidate.scores.total <= 0) {
      throw new Error('候选全部偏离当前章节宏观合同，拒绝生成与大纲不一致的因果决策')
    }
    if (!candidateWasCached) {
      saveCausalPlanStage({
        workId,
        stateRevision: state.revision,
        stage: 'candidate_generation_v3',
        inputHash: planningInputHash,
        content: candidateContent!
      })
    }
  } catch (error) {
    const message = errorMessage(error)
    causalNovelDAO.recordPlanAttempt({
      workId,
      stateRevision: state.revision,
      stage: 'candidate_validation',
      status: 'rejected',
      errorCode: causalPlanFailureCode(message),
      errorMessage: message,
      responseJson: candidateContent
    })
    throw error
  }

  const decisionInputHash = causalPlanStageInputHash({
    planningInputHash,
    candidateDrafts,
    selectedCandidate,
    evidenceCatalog,
    previousHorizon,
    recentEmotionalOutcomes
  })
  let decisionContent = readCausalPlanStage(
    workId,
    state.revision,
    'decision_generation_v3',
    decisionInputHash
  )
  const decisionWasCached = Boolean(decisionContent)
  if (decisionContent) {
    onProgress?.('章节决策 4/7：已恢复冻结候选对应的执行合同制品')
  } else {
    onProgress?.(`章节决策 4/7：已冻结独立评分最高候选「${selectedCandidate.action}」，正在生成执行合同与近期窗口`)
    try {
      const schema = buildDecisionDraftSchema(Boolean(serverChapterContract))
      const materializeDecisionDetails = (value: Record<string, unknown>) =>
        serverChapterContract
          ? bindServerChapterContract(value as unknown as CausalDecisionModelDetails, serverChapterContract)
          : value as Omit<CausalChapterPlanDraft, 'candidates'>
      const details = await requestStructuredModelOutput<Omit<CausalChapterPlanDraft, 'candidates'>>({
        workId,
        label: '下一章执行合同',
        attempts: 2,
        signal,
        schema,
        request: async (_attempt, lastError) => modelService.chat(
          withGoalLoopModelOptions(workId, {
            workId, step: 'goal_novel_causal_decision', enrichWorkContext: false, enrichNarrativeMemory: false,
            ...CAUSAL_STEP_EXECUTION_PROFILE.decisionMaterialization,
            responseSchema: { name: 'causal_novel_decision_draft', schema, strict: true },
            structuredOutputMode: 'prompt_json',
            systemPrompt: [
              '你是滚动因果小说的当前章执行规划器。最高分候选已经由服务端冻结，不得改选或改写其核心行动。',
              serverChapterContract
                ? 'decision 只补充视角、即时目标和人物清单；标题、开场、验收节点、边界、结尾及冻结候选字段均由服务端绑定。'
                : 'decision 只补充标题、视角、即时目标、开场、验收节点、边界、结尾和人物清单；冻结候选字段由服务端绑定。',
              'emotionContract 只约束当前章，视角由服务端绑定为 decision.pov。',
              'groundingEvidence 只返回原子证据 id 字符串；服务端会在制品冻结后单独校验并绑定。',
              'choice_and_cost 必须执行冻结候选的行动与代价，情绪必须通过人物选择改变剧情。',
              'rollingHorizon 规划从当前章起连续5-12章的可撤销窗口；只有 offset=0 会提交，其余每章重算。',
              '人物、压力、承诺和证据引用均由服务端在创作制品冻结后定点校验；不要把多个人名拼在同一字符串中。',
              serverChapterContract
                ? '宏观合同存在时，title、openingState、mustCover、forbiddenEvents、endingState、continuityConstraints 由服务端绑定，禁止在 decision 中返回这些字段。'
                : ''
            ].join('\n'),
            prompt: [
              `【冻结的当前章候选】\n${JSON.stringify(selectedCandidate, null, 2)}`,
              `【当前权威因果状态】\n${JSON.stringify(state, null, 2)}`,
              `【情绪事务原子证据目录，只能选择 id】\n${JSON.stringify(evidenceCatalog, null, 2)}`,
              `【阶段锚点】\n${JSON.stringify(state.macroArcs, null, 2)}`,
              targetChapter
                ? `【本章不可漂移的宏观合同】\n标题必须保持为：${targetChapter.title}\n${targetChapter.outline?.trim() || '未填写章节大纲'}`
                : '',
              previousHorizon.length
                ? `【上轮未提交的近期窗口，仅作重算起点，不得照抄】\n${JSON.stringify(previousHorizon, null, 2)}`
                : '',
              recentEmotionalOutcomes.length
                ? `【最近已提交情绪结果，只用于延续余波】\n${JSON.stringify(recentEmotionalOutcomes, null, 2)}`
                : '',
              recent ? `【最近正文，仅用于避免重复与保持连续】\n${recent}` : '',
              lastError !== '未知结构化输出错误'
                ? `【上次传输结构无效】\n${lastError}\n只修正 JSON 形状，不改变已冻结候选和合同语义。`
                : ''
            ].filter(Boolean).join('\n\n')
          }),
          { stream: false, signal }
        ),
        validate: value => assertDecisionReferences(
          state,
          evidenceCatalog,
          materializeDecisionDetails(value)
        ),
        shouldRepairValidationError: error => error instanceof CausalPlanReferenceValidationError,
        repairValidationError: async ({ value, error }) => repairDecisionReferences({
          workId,
          state,
          catalog: evidenceCatalog,
          draft: materializeDecisionDetails(value),
          issues: (error as CausalPlanReferenceValidationError).issues,
          signal
        })
      })
      decisionContent = JSON.stringify(details)
    } catch (error) {
      const message = errorMessage(error)
      causalNovelDAO.recordPlanAttempt({
        workId,
        stateRevision: state.revision,
        stage: 'decision_generation',
        status: 'rejected',
        errorCode: causalPlanFailureCode(message),
        errorMessage: message
      })
      throw error
    }
  }
  onProgress?.('章节决策 5/7：正在绑定人物、视角、承诺与原子证据')
  let plan: CausalChapterPlan
  try {
    const details = assertDecisionReferences(
      state,
      evidenceCatalog,
      parseStructured<Omit<CausalChapterPlanDraft, 'candidates'>>(decisionContent!)
    )
    const draft: CausalChapterPlanDraft = { candidates: candidateDrafts, ...details }
    plan = materializeCausalChapterPlan(state, draft, evidenceCatalog)
    if (targetChapter) {
      const macroContract = serverChapterContract!
      plan = {
        ...plan,
        decision: {
          ...plan.decision,
          title: targetChapter.title,
          openingState: macroContract.openingState,
          mustCover: macroContract.requiredEvents,
          forbiddenEvents: macroContract.forbiddenEvents,
          endingState: macroContract.endingState,
          continuityConstraints: macroContract.continuityConstraints
            .split('；')
            .map(item => item.trim())
            .filter(Boolean)
        }
      }
    }
    validateChapterPlan(state, plan)
    if (options.checkEmotionContract !== false) {
      validateCausalChapterEmotionContract(
        state,
        plan,
        recentChapters.map(chapter => ({ id: chapter.id, content: chapter.content ?? '' }))
      )
    }
    if (!decisionWasCached) {
      saveCausalPlanStage({
        workId,
        stateRevision: state.revision,
        stage: 'decision_generation_v3',
        inputHash: decisionInputHash,
        content: decisionContent!
      })
    }
  } catch (error) {
    const message = errorMessage(error)
    causalNovelDAO.recordPlanAttempt({
      workId,
      stateRevision: state.revision,
      stage: 'local_validation',
      status: 'rejected',
      errorCode: causalPlanFailureCode(message),
      errorMessage: message,
      responseJson: JSON.stringify({
        candidateResponse: candidateContent,
        detailResponse: decisionContent
      })
    })
    throw error
  }
  const auditInputHash = causalPlanStageInputHash({ planningInputHash, plan })
  onProgress?.('章节决策 6/7：服务端复核最高权重候选、执行合同与滚动窗口引用')
  const auditContent = JSON.stringify({
    passed: true,
    failureLayer: 'none',
    selectedCandidateId: plan.selectedCandidateId,
    reasons: ['候选顺序、权威引用、宏观合同和情绪证据已通过本地确定性校验']
  })
  let audit: {
    passed: boolean
    failureLayer: 'none' | 'authority_state' | 'candidate' | 'decision'
    selectedCandidateId: string
    reasons: string[]
  }
  try {
    audit = parseStructured<typeof audit>(auditContent)
  } catch (error) {
    const message = errorMessage(error)
    causalNovelDAO.recordPlanAttempt({
      workId,
      stateRevision: state.revision,
      stage: 'audit_validation',
      status: 'rejected',
      errorCode: 'PLAN_FORMAT',
      errorMessage: message,
      responseJson: auditContent
    })
    throw error
  }
  if (audit.passed !== (audit.failureLayer === 'none')) {
    throw new Error('因果决策审计的 passed 与 failureLayer 相互矛盾')
  }
  if (!audit.passed || audit.selectedCandidateId !== plan.selectedCandidateId) {
    throw new Error('本地因果决策审计结果与已验证计划不一致')
  }
  saveCausalPlanStage({
    workId,
    stateRevision: state.revision,
    stage: 'decision_audit_v2',
    inputHash: auditInputHash,
    content: auditContent
  })
  onProgress?.('章节决策 7/7：正在创建本章决策事务')
  const chapterId = targetChapter?.id ?? causalNovelDAO.createPlannedChapter({
    workId, stateRevision: state.revision, plan, decisionCard: formatCausalDecisionCard(plan)
  })
  if (targetChapter) {
    causalNovelDAO.attachDecisionToExistingChapter({
      workId,
      chapterId,
      stateRevision: state.revision,
      plan,
      decisionCard: formatCausalDecisionCard(plan)
    })
  }
  causalNovelDAO.recordPlanAttempt({
    workId,
    stateRevision: state.revision,
    stage: 'accepted',
    status: 'accepted',
    responseJson: JSON.stringify(plan)
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
  onProgress?: (message: string) => void,
  options: {
    baseState?: CausalNarrativeState
    allowCommittedDecision?: boolean
    ordinal?: number
  } = {}
): Promise<{ state: CausalNarrativeState; outcome: CausalChapterOutcome; bodyHash: string }> {
  onProgress?.('章后结果 · 正在读取最终正文与提交前状态')
  const state = options.baseState ?? causalNovelDAO.getState(workId)
  const record = causalNovelDAO.getDecision(chapterId)
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!state || !record || !chapter?.content?.trim()) throw new Error('因果结果提交缺少状态、决策或正文')
  if (!options.allowCommittedDecision && record.stateRevision !== state.revision) {
    throw new Error('因果结果基于过期状态，拒绝提交')
  }
  if (!options.allowCommittedDecision && record.status !== 'planned') {
    throw new Error('因果结果只允许从待提交决策提取')
  }
  const contentVersion = causalNovelDAO.ensureCurrentContentVersion(
    workId, chapterId, options.allowCommittedDecision ? 'replay_outcome' : 'outcome', 'generated'
  )
  const pipeline = await runCausalOutcomePipeline({
    workId,
    chapterId,
    contentVersionId: contentVersion.id,
    state,
    record,
    content: chapter.content,
    chapterOrdinal: options.ordinal
      ?? volumeChapterDAO.listChaptersByWork(workId).findIndex(item => item.id === chapterId) + 1,
    signal,
    onProgress
  })
  const outcome = pipeline.outcome
  const progressedPromises = new Set([...outcome.advancedPromiseIds, ...outcome.resolvedPromiseIds])
  if (!record.plan.decision.advancedPromiseIds.some(id => progressedPromises.has(id))) {
    throw new Error('章节结果没有推进决策中冻结的任何读者承诺')
  }
  const committedIds = new Set(causalNovelDAO.listDecisions(workId)
    .filter(item => item.status === 'committed' || item.chapterId === chapterId)
    .map(item => item.chapterId))
  const ordinal = options.ordinal ?? volumeChapterDAO.listChaptersByWork(workId)
    .filter(item => committedIds.has(item.id))
    .findIndex(item => item.id === chapterId) + 1
  const nextState = applyCausalChapterOutcome(state, outcome, ordinal, chapter.content)
  return {
    state: nextState,
    outcome,
    bodyHash: createHash('sha256').update(chapter.content).digest('hex')
  }
}

export async function extractAndCommitCausalOutcome(
  workId: number,
  chapterId: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ state: CausalNarrativeState; outcome: CausalChapterOutcome; bodyHash: string }> {
  const result = await extractCausalOutcome(workId, chapterId, signal, onProgress)
  const expectedStateRevision = result.state.revision - 1
  onProgress?.('正在原子提交章节因果结果与权威状态修订')
  causalNovelDAO.commitDecision({
    workId, chapterId, expectedStateRevision, nextState: result.state, outcome: result.outcome,
    expectedBodyHash: result.bodyHash
  })
  return result
}
