import assert from 'node:assert/strict'
import {
  CAUSAL_NOVEL_SCHEMA_VERSION,
  applyCausalChapterOutcome,
  buildCausalEvidenceCatalog,
  causalChapterCountBounds,
  causalCandidateTotal,
  causalEmotionGroundingRefs,
  formatCausalDecisionCard,
  materializeCausalChapterPlan,
  materializeCausalCandidates,
  normalizeCausalNarrativeState,
  registerCausalPlanFailure,
  validateCausalChapterEmotionContract,
  type CausalChapterOutcome,
  type CausalChapterPlan,
  type CausalChapterPlanDraft,
  type CausalNarrativeState
} from '../src/shared/causal-novel-types'
import {
  CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX,
  CAUSAL_OUTCOME_AUDIT_BATCH_SIZE,
  CAUSAL_OUTCOME_PROTOCOL_VERSION,
  CausalOutcomeProtocolError,
  buildCausalBodyEvidenceUnits,
  causalOutcomeAuditBatches,
  causalOutcomeFailureCode,
  causalOutcomeFailureIssues,
  isCausalPhysicalConditionValue,
  materializeCausalOutcomeDraft,
  validateCausalEvidenceIds,
  validateCausalStageEvidence,
  type CausalOutcomeDraftBundle
} from '../src/shared/causal-outcome-protocol'
import {
  CAUSAL_CORE_SEMANTIC_EVIDENCE_MAX,
  applyCausalCoreSemanticRepairs,
  atomicOutcomeArtifactHash,
  atomicOutcomeClaimEvidenceText,
  buildAtomicOutcomeClaims,
  materializeAtomicOutcomeClaims
} from '../src/shared/causal-outcome-atomic'
import { validateCausalOutcomeActorMutationReferences } from '../src/main/context/goal-routine/causal-outcome-actor-references'
import {
  projectCausalOutcomeActorPromptState,
  projectCausalOutcomeState
} from '../src/main/context/goal-routine/causal-outcome-context'
import { applyWorldAtomizationRepairPatch } from '../src/main/context/goal-routine/causal-outcome-world-atomization'
import {
  bindServerChapterContract,
  stripServerBoundDecisionSchema,
  type CausalDecisionModelDetails
} from '../src/main/context/goal-routine/causal-decision-server-contract'

const state: CausalNarrativeState = {
  schemaVersion: CAUSAL_NOVEL_SCHEMA_VERSION,
  revision: 2,
  centralQuestion: '林舟会不会公开寿命交易的真相？',
  terminalConditions: ['林舟对是否公开真相作出不可逆选择'],
  immutableRules: ['寿命转移后不能自然恢复'],
  actors: [{
    name: '林舟', currentGoal: '救母亲', fear: '母亲死亡',
    knowledge: ['黑市存在'], resources: ['匿名身份'], constraint: '不能直接购买寿命',
    location: '黑市入口', physicalState: '健康', relationships: ['周岚：互不信任'], obligations: ['救母亲']
  }, {
    name: '周岚', currentGoal: '调查黑市', fear: '证据被毁',
    knowledge: ['林舟进入过黑市'], resources: ['调查权限'], constraint: '没有直接证据',
    location: '调查局', physicalState: '健康', relationships: ['林舟：调查对象'], obligations: []
  }],
  activePressures: [{
    id: 'pressure_black_market', source: '黑市追踪者', target: '林舟',
    condition: '追踪者正在查找截取寿命的人', escalation: '身份将在一天内暴露', urgency: 7, status: 'active'
  }],
  promises: [{
    id: 'promise_ability', question: '林舟为什么能截取寿命？', status: 'open',
    openedChapter: 1, lastAdvancedChapter: 1
  }],
  macroArcs: [{
    id: 'arc_truth', title: '追查黑市', objective: '确认寿命交易真相',
    entryConditions: ['黑市存在'], exitConditions: ['真相得到确认'],
    mandatoryPayoffs: ['能力来源'], forbiddenDrift: ['寿命转移不能恢复'],
    status: 'active', lastAdvancedChapter: 1
  }],
  macroArchitectureReady: true,
  archivedPromiseIds: [],
  recentEventSignatures: ['林舟第一次进入黑市'],
  completionStatus: 'writing', completionAuditFeedback: [],
  completed: false,
  completionReason: ''
}

const legacyNormalized = normalizeCausalNarrativeState({
  ...state,
  schemaVersion: 1,
  macroArcs: undefined,
  macroArchitectureReady: undefined,
  archivedPromiseIds: undefined,
  completionStatus: undefined,
  completionAuditFeedback: undefined
} as unknown as CausalNarrativeState)
assert.equal(legacyNormalized.schemaVersion, CAUSAL_NOVEL_SCHEMA_VERSION)
assert.equal(legacyNormalized.macroArchitectureReady, false)
assert.equal(legacyNormalized.macroArcs.length, 1)

let failureHistory: Array<{ revision: number; code: string }> = []
for (const code of ['PLAN_IDENTITY', 'PLAN_EVIDENCE', 'PLAN_HORIZON']) {
  const decision = registerCausalPlanFailure(failureHistory, { revision: 0, code })
  failureHistory = decision.history
  if (code === 'PLAN_HORIZON') assert.equal(decision.shouldPause, true)
}
const newRevisionFailure = registerCausalPlanFailure(failureHistory, { revision: 1, code: 'PLAN_IDENTITY' })
assert.equal(newRevisionFailure.shouldPause, false)

const content = '追踪者摘下兜帽，说出了林舟母亲的名字。林舟终于确认，父亲曾经替黑市工作。'
const outcome: CausalChapterOutcome = {
  summary: '追踪者用母亲威胁林舟，并暴露父亲与黑市的联系。',
  eventSignature: '追踪者以母亲威胁林舟并暴露父亲身份',
  evidenceQuotes: ['追踪者摘下兜帽', '父亲曾经替黑市工作'],
  evidenceRefs: [{ id: 'e_test', text: '追踪者摘下兜帽' }],
  mutations: [
    {
      id: 'm_test_core', kind: 'core_summary', subject: 'chapter',
      claim: '追踪者用母亲威胁林舟', evidenceIds: ['e_test'], required: true
    },
    {
      id: 'm_test_promise', kind: 'promise_advance', subject: 'promise_ability',
      claim: '推进能力承诺', evidenceIds: ['e_test'], required: true
    },
    {
      id: 'm_test_new_promise', kind: 'promise_open', subject: 'new:0',
      claim: '打开父亲悬念', evidenceIds: ['e_test'], required: false
    },
    {
      id: 'm_test_actor', kind: 'actor_state', subject: '林舟:knowledgeAdded:0',
      claim: '林舟得知父亲曾为黑市工作', evidenceIds: ['e_test'], required: false
    },
    {
      id: 'm_test_pressure', kind: 'pressure_state', subject: 'pressure_black_market:condition',
      claim: '黑市压力升级', evidenceIds: ['e_test'], required: false
    },
    ...(['reader_effect', 'trigger', 'choice', 'cost', 'residue'] as const).map(subject => ({
      id: `m_test_emotion_${subject}`,
      kind: 'emotion_result' as const,
      subject,
      claim: `情绪结果 ${subject}`,
      evidenceIds: ['e_test'],
      required: true
    }))
  ],
  advancedPromiseIds: ['promise_ability'],
  resolvedPromiseIds: [],
  newPromises: [{ id: 'promise_father', question: '父亲在黑市中做过什么？' }],
  actorUpdates: [{
    actor: '林舟', knowledgeAdded: ['父亲曾经替黑市工作'], evidence: '父亲曾经替黑市工作'
  }],
  newActors: [],
  pressureUpdates: [{
    id: 'pressure_black_market', status: 'escalated', urgency: 9,
    condition: '追踪者掌握母亲身份并直接威胁林舟', evidence: '说出了林舟母亲的名字'
  }],
  newPressures: [],
  arcUpdates: [],
  emotionalOutcome: {
    readerEffectSummary: '读者确认威胁已经触及林舟母亲，并开始追问父亲的隐瞒。',
    triggerEvidence: '说出了林舟母亲的名字',
    choiceEvidence: '林舟终于确认',
    costEvidence: '追踪者摘下兜帽',
    residueEvidence: '父亲曾经替黑市工作',
    emotionalDebtOpened: '林舟必须重新判断父亲留下的秘密',
    emotionalDebtPaid: ''
  },
  terminalConditionMet: false,
  matchedTerminalCondition: '', terminalEvidence: '',
  completionReason: ''
}

const next = applyCausalChapterOutcome(state, outcome, 3, content)
assert.equal(next.revision, 3)
assert.equal(next.promises.find(item => item.id === 'promise_ability')?.status, 'advanced')
assert.equal(next.promises.find(item => item.id === 'promise_father')?.openedChapter, 3)
assert.equal(next.activePressures[0].urgency, 9)
assert.ok(next.actors[0].knowledge.includes('父亲曾经替黑市工作'))

assert.throws(
  () => applyCausalChapterOutcome(
    { ...state, recentEventSignatures: [...state.recentEventSignatures, outcome.eventSignature] },
    outcome,
    3,
    content
  ),
  /REPEATED_EVENT_SIGNATURE/
)
assert.throws(
  () => applyCausalChapterOutcome(state, {
    ...outcome,
    newPromises: [{ id: 'promise_duplicate', question: '林舟为什么能截取寿命' }]
  }, 3, content),
  /DUPLICATE_READER_PROMISE/
)
assert.throws(
  () => applyCausalChapterOutcome(state, {
    ...outcome,
    actorUpdates: [],
    pressureUpdates: [],
    newActors: [],
    newPressures: [],
    arcUpdates: [],
    resolvedPromiseIds: []
  }, 3, content),
  /CHAPTER_NO_MATERIAL_PROGRESS/
)
assert.throws(
  () => applyCausalChapterOutcome(state, outcome, 4, content),
  /MACRO_ARC_STAGNATION/
)

assert.throws(
  () => applyCausalChapterOutcome(state, { ...outcome, evidenceQuotes: ['正文里不存在的句子'] }, 3, content),
  /缺少正文逐字证据/
)
assert.doesNotThrow(() => applyCausalChapterOutcome(
  state,
  { ...outcome, evidenceQuotes: ['追踪者摘下兜帽，说出了林舟母亲的名字。\n林舟终于确认'] },
  3,
  '追踪者摘下兜帽，说出了林舟母亲的名字。林舟终于确认，父亲曾经替黑市工作。'
))
assert.throws(
  () => applyCausalChapterOutcome(state, {
    ...outcome,
    advancedPromiseIds: ['unknown'],
    mutations: [
      ...outcome.mutations.filter(item => item.kind !== 'promise_advance'),
      {
        id: 'm_test_unknown_promise', kind: 'promise_advance', subject: 'unknown',
        claim: '推进未知承诺', evidenceIds: ['e_test'], required: true
      }
    ]
  }, 3, content),
  /不存在或已归档的读者承诺/
)
assert.throws(
  () => applyCausalChapterOutcome(state, { ...outcome, emotionalOutcome: undefined as never }, 3, content),
  /缺少已经挣得的情绪结果摘要/
)
const newActorContent = `${content}陌生人自称顾淮。`
const withNewActor = applyCausalChapterOutcome(state, {
  ...outcome,
  mutations: [
    ...outcome.mutations,
    {
      id: 'm_test_new_actor', kind: 'actor_create', subject: '顾淮:name',
      claim: '新增人物顾淮', evidenceIds: ['e_test'], required: true
    }
  ],
  newActors: [{
    actor: {
      name: '顾淮', currentGoal: '', fear: '', knowledge: [], resources: [], constraint: ''
    },
    evidence: '陌生人自称顾淮'
  }]
}, 3, newActorContent)
assert.ok(withNewActor.actors.some(actor => actor.name === '顾淮'))
const proposedCompletion = applyCausalChapterOutcome(state, {
  ...outcome,
  mutations: [
    ...outcome.mutations,
    {
      id: 'm_test_terminal', kind: 'terminal_state',
      subject: '林舟对是否公开真相作出不可逆选择',
      claim: '林舟作出不可逆选择', evidenceIds: ['e_test'], required: true
    }
  ],
  terminalConditionMet: true,
  matchedTerminalCondition: '林舟对是否公开真相作出不可逆选择',
  terminalEvidence: '林舟终于确认',
  completionReason: '林舟已经作出不可逆选择'
}, 3, content)
assert.equal(proposedCompletion.completionStatus, 'proposed')
assert.equal(proposedCompletion.completed, false)

const indexedContent = [
  '追踪者摘下兜帽，说出了林舟母亲的名字。林舟没有后退。',
  '他终于确认，父亲曾经替黑市工作。'
].join('\n')
const evidenceUnits = buildCausalBodyEvidenceUnits(indexedContent)
assert.deepEqual(evidenceUnits.map(item => item.id), ['e0001', 'e0002', 'e0003'])
assert.equal(evidenceUnits[0].text, '追踪者摘下兜帽，说出了林舟母亲的名字。')
assert.equal(evidenceUnits[2].paragraph, 2)
assert.throws(
  () => validateCausalEvidenceIds(evidenceUnits, ['e9999'], 'core.evidenceIds'),
  (error: unknown) => error instanceof CausalOutcomeProtocolError && error.code === 'OUTCOME_EVIDENCE_ID'
)
assert.throws(
  () => validateCausalEvidenceIds(evidenceUnits, [], 'core.evidenceIds'),
  /需要 1-8 个正文证据 ID/
)
const sevenEvidenceUnits = buildCausalBodyEvidenceUnits(
  Array.from({ length: 7 }, (_, index) => `证据段落${index + 1}。`).join('\n')
)
assert.throws(
  () => validateCausalStageEvidence(
    { evidenceIds: sevenEvidenceUnits.map(item => item.id) },
    sevenEvidenceUnits
  ),
  (error: unknown) => (
    error instanceof CausalOutcomeProtocolError &&
    error.code === 'OUTCOME_ATOMIZATION_REQUIRED' &&
    error.issues[0]?.actualCount === 7 &&
    error.issues[0]?.max === CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX
  )
)
assert.doesNotThrow(() => validateCausalStageEvidence(
  { terminal: { conditionMet: false, evidenceIds: [] } },
  evidenceUnits
))
assert.throws(
  () => validateCausalStageEvidence(
    { choiceEvidenceIds: sevenEvidenceUnits.slice(0, 5).map(item => item.id) },
    sevenEvidenceUnits
  ),
  /实际包含 5 个正文证据 ID，单条原子结论上限为 4/
)

const stagedOutcomeDraft: CausalOutcomeDraftBundle = {
  core: {
    primaryEvent: {
      claim: '追踪者以母亲施压',
      eventSignature: '母亲威胁揭开父亲黑市联系',
      evidenceIds: ['e0001']
    },
    supportingEvents: [{
      claim: '林舟确认父亲与黑市有关',
      evidenceIds: ['e0003']
    }],
    advancedPromises: [{
      promiseId: 'promise_ability',
      claim: '林舟确认父亲曾为黑市工作，能力来源悬念得到实质推进',
      evidenceIds: ['e0003']
    }],
    resolvedPromises: [],
    newPromises: [{
      question: '父亲曾为黑市做过什么？',
      claim: '父亲曾为黑市工作的事实打开新的追问',
      evidenceIds: ['e0003']
    }],
    terminal: {
      conditionMet: false,
      matchedCondition: '',
      completionReason: '',
      evidenceIds: []
    }
  },
  actors: {
    actorMutations: [
      {
        actor: '林舟', field: 'currentGoal', operation: 'set',
        value: '查清父亲与黑市的关系', evidenceIds: ['e0003']
      },
      {
        actor: '林舟', field: 'knowledge', operation: 'add',
        value: '父亲曾替黑市工作', evidenceIds: ['e0003']
      },
      {
        actor: '林舟', field: 'constraint', operation: 'set',
        value: '母亲身份已被追踪者掌握', evidenceIds: ['e0001']
      }
    ],
    newActors: []
  },
  world: {
    pressureConditionUpdates: [],
    pressureStatusUpdates: [],
    pressureUrgencyUpdates: [],
    newPressures: [],
    arcUpdates: []
  },
  emotion: {
    readerEffect: {
      claim: '威胁触及母亲，同时打开父亲旧事的悬念',
      evidenceIds: ['e0001']
    },
    trigger: { claim: '追踪者说出母亲的名字', evidenceIds: ['e0001'] },
    choice: { claim: '林舟继续确认父亲的旧事', evidenceIds: ['e0002'] },
    cost: { claim: '母亲身份暴露', evidenceIds: ['e0001'] },
    residue: { claim: '父亲与黑市的联系留下悬念', evidenceIds: ['e0003'] },
    debtOpened: { claim: '父亲与黑市的旧账', evidenceIds: ['e0003'] },
    debtPaid: { claim: '', evidenceIds: [] }
  }
}
const stagedMutations: CausalChapterOutcome['mutations'] = [
  {
    id: 'm_staged_core', kind: 'core_summary', subject: 'chapter',
    claim: stagedOutcomeDraft.core.primaryEvent.claim, evidenceIds: ['e0001'], required: true
  },
  {
    id: 'm_staged_promise', kind: 'promise_advance', subject: 'promise_ability',
    claim: '推进能力承诺', evidenceIds: ['e0001'], required: true
  },
  {
    id: 'm_staged_new_promise', kind: 'promise_open', subject: 'new:0',
    claim: '打开父亲悬念', evidenceIds: ['e0003'], required: false
  },
  {
    id: 'm_staged_actor', kind: 'actor_state', subject: '林舟:currentGoal',
    claim: '林舟改变目标', evidenceIds: ['e0003'], required: false
  },
  ...(['reader_effect', 'trigger', 'choice', 'cost', 'residue'] as const).map(subject => ({
    id: `m_staged_emotion_${subject}`,
    kind: 'emotion_result' as const,
    subject,
    claim: `情绪结果 ${subject}`,
    evidenceIds: ['e0001'],
    required: true
  }))
]
const stagedOutcome = materializeCausalOutcomeDraft({
  state, units: evidenceUnits, draft: stagedOutcomeDraft, mutations: stagedMutations
})
assert.equal(CAUSAL_OUTCOME_PROTOCOL_VERSION, 29)
const serverBoundDecisionSchema = stripServerBoundDecisionSchema({
  type: 'object',
  additionalProperties: false,
  required: [
    'title', 'pov', 'immediateWant', 'openingState', 'mustCover',
    'forbiddenEvents', 'endingState', 'continuityConstraints', 'characters'
  ],
  properties: {
    title: { type: 'string' },
    pov: { type: 'string' },
    immediateWant: { type: 'string' },
    openingState: { type: 'string' },
    mustCover: { type: 'array' },
    forbiddenEvents: { type: 'array', maxItems: 8 },
    endingState: { type: 'string' },
    continuityConstraints: { type: 'array' },
    characters: { type: 'array' }
  }
}) as { required: string[]; properties: Record<string, unknown> }
assert.deepEqual(serverBoundDecisionSchema.required, ['pov', 'immediateWant', 'characters'])
assert.deepEqual(Object.keys(serverBoundDecisionSchema.properties), ['pov', 'immediateWant', 'characters'])
const boundDecisionDetails = bindServerChapterContract({
  decision: { pov: '林舟', immediateWant: '守住入口', characters: ['林舟'] },
  emotionContract: {} as CausalDecisionModelDetails['emotionContract'],
  rollingHorizon: []
}, {
  chapterTitle: '第52章 第四十五道门',
  openingState: '门外响起铁器拖地声',
  requiredEvents: ['钉死挡片', '稳住邻居'],
  forbiddenEvents: Array.from({ length: 10 }, (_, index) => `禁止事件${index + 1}`),
  endingState: '第四十五道门锁死',
  continuityConstraints: '锁扣已消耗；刘梅仍被控制'
})
assert.equal(boundDecisionDetails.decision.forbiddenEvents.length, 10)
assert.deepEqual(boundDecisionDetails.decision.continuityConstraints, ['锁扣已消耗', '刘梅仍被控制'])
assert.throws(
  () => validateCausalOutcomeActorMutationReferences({
    actorMutations: [{
      actor: '王婶',
      field: 'knowledge',
      operation: 'add',
      value: '林舟设下了诱饵陷阱',
      evidenceIds: ['e0001']
    }],
    newActors: []
  }, ['林舟', '周岚']),
  error => error instanceof CausalOutcomeProtocolError
    && error.code === 'OUTCOME_REFERENCE'
    && error.paths[0] === 'actors.actorMutations[0].actor'
    && error.message.includes('必须改写到 newActors')
)
assert.equal(isCausalPhysicalConditionValue('半枚沾血的金属徽章'), false)
assert.equal(isCausalPhysicalConditionValue('用于确认伤势的诊断报告'), false)
assert.equal(isCausalPhysicalConditionValue('左臂骨折并持续疼痛'), true)
assert.equal(stagedOutcome.summary, '追踪者以母亲施压；林舟确认父亲与黑市有关')
assert.equal(stagedOutcome.newPromises[0].id, 'p1')
assert.deepEqual(stagedOutcome.actorUpdates[0].evidenceIds, ['e0003', 'e0001'])
assert.doesNotThrow(() => applyCausalChapterOutcome(state, stagedOutcome, 3, indexedContent))
assert.equal(causalOutcomeFailureCode(new Error('情绪结果提取连续 2 次结构化输出无效：Unexpected token')), 'OUTCOME_SCHEMA')
assert.equal(causalOutcomeFailureCode(new Error('核心事件提取连续 2 次结构化输出无效：核心事件没有推进冻结决策中的任何读者承诺')), 'OUTCOME_PROMISE_PROGRESS')
assert.equal(causalOutcomeFailureCode(new CausalOutcomeProtocolError('OUTCOME_ENTAILMENT', '审计失败')), 'OUTCOME_ENTAILMENT')
const atomizationError = new Error(
  '核心事件提取连续 2 次结构化输出无效：core.primaryEvent.evidenceIds 实际包含 10 个正文证据 ID，单条原子结论上限为 4；需要拆分结论'
)
assert.equal(causalOutcomeFailureCode(atomizationError), 'OUTCOME_ATOMIZATION_REQUIRED')
assert.deepEqual(causalOutcomeFailureIssues(atomizationError), [{
  path: 'core.primaryEvent.evidenceIds',
  actualCount: 10,
  max: 4
}])
const worldAtomizationInput = {
  pressureConditionUpdates: [{
    id: 'ap22',
    value: '多个过程事实被错误聚合为同一个压力条件',
    evidenceIds: ['e0001', 'e0002', 'e0003', 'e0004', 'e0005']
  }],
  pressureStatusUpdates: [{
    id: 'ap22', value: 'escalated', evidenceIds: ['e0004', 'e0005']
  }],
  pressureUrgencyUpdates: [],
  newPressures: [],
  arcUpdates: []
}
const worldAtomizationPatched = applyWorldAtomizationRepairPatch(
  worldAtomizationInput,
  [{ path: 'pressureConditionUpdates[0].evidenceIds' }],
  {
    r001: {
      statement: '章末外区掠夺者已明确逼近楼内',
      evidenceIds: ['e0004', 'e0005']
    }
  }
)
assert.equal(
  (worldAtomizationPatched.pressureConditionUpdates as Array<{ id: string }>).length,
  1
)
assert.deepEqual(worldAtomizationPatched.pressureConditionUpdates, [{
  id: 'ap22',
  value: '章末外区掠夺者已明确逼近楼内',
  evidenceIds: ['e0004', 'e0005']
}])
assert.deepEqual(worldAtomizationPatched.pressureStatusUpdates, worldAtomizationInput.pressureStatusUpdates)
assert.throws(
  () => applyWorldAtomizationRepairPatch(
    worldAtomizationInput,
    [{ path: 'pressureConditionUpdates[0].evidenceIds' }],
    {
      r001: { statement: '章末压力', evidenceIds: ['e0004'] },
      r002: { statement: '重复压力', evidenceIds: ['e0005'] }
    }
  ),
  /必须且只能覆盖全部固定修复槽位/
)
assert.equal(
  causalOutcomeFailureCode(new Error('因果结果失败声明定点修复连续 1 次结构化输出无效：输出达到长度上限（finishReason=length）')),
  'OUTCOME_TRUNCATED'
)
const largeAuditBatches = causalOutcomeAuditBatches(
  Array.from({ length: 45 }, (_, index) => `c${String(index + 1).padStart(3, '0')}`)
)
assert.equal(CAUSAL_OUTCOME_AUDIT_BATCH_SIZE, 6)
assert.equal(largeAuditBatches.length, 8)
assert.ok(largeAuditBatches.every(batch => batch.length <= CAUSAL_OUTCOME_AUDIT_BATCH_SIZE))
assert.deepEqual(largeAuditBatches.at(-1), ['c043', 'c044', 'c045'])
assert.throws(() => causalOutcomeAuditBatches(['c001'], 0), /批大小必须是正整数/)
assert.throws(
  () => materializeCausalOutcomeDraft({
    state,
    units: evidenceUnits,
    mutations: stagedMutations,
    draft: {
      ...stagedOutcomeDraft,
      world: {
        ...stagedOutcomeDraft.world,
        pressureStatusUpdates: [{
          id: 'pressure_black_market', value: 'escalated', evidenceIds: ['e0001']
        }],
        pressureUrgencyUpdates: [{
          id: 'pressure_black_market', value: 4, evidenceIds: ['e0001']
        }]
      }
    }
  }),
  (error: unknown) => error instanceof CausalOutcomeProtocolError && error.code === 'OUTCOME_OPERATION'
)

const plan: CausalChapterPlan = {
  candidates: [{
    id: 'c1', initiator: '林舟', action: '反向跟踪追踪者', opposition: '追踪者掌握母亲身份',
    cost: '暴露异常能力', irreversibleChange: '确认父亲与黑市有关',
    promiseAdvanced: 'promise_ability', newQuestion: '父亲为何替黑市工作？',
    scores: { causalNecessity: 90, promiseProgress: 90, irreversibleImpact: 85, novelty: 80, pressureEscalation: 88, total: 87 }
  }],
  selectedCandidateId: 'c1',
  decision: {
    title: '母亲的名字', pov: '林舟', initiator: '林舟', immediateWant: '摆脱追踪',
    chosenAction: '反向跟踪追踪者', opposition: '追踪者掌握母亲身份', cost: '暴露异常能力',
    openingState: '林舟被追踪', mustCover: ['确认追踪者目标', '主动反制'],
    forbiddenEvents: ['不得提前解决黑市真相'], endingState: '林舟确认父亲与黑市有关',
    continuityConstraints: ['母亲仍在医院'], characters: ['林舟', '追踪者'],
    advancedPromiseIds: ['promise_ability'], newQuestion: '父亲为何替黑市工作？'
  },
  emotionContract: {
    pov_character: '林舟', attachment_anchor: '林舟救母亲的目标正在被追踪者利用',
    value_at_stake: '母亲的安全与林舟对父亲的信任',
    reader_state_before: { label: '担忧', valence: -1, arousal: 2, agency: -1, certainty: 2 },
    trigger_event: '追踪者说出母亲的名字',
    character_appraisal: {
      perceived_meaning: '敌人已经越过身份追踪，直接触及母亲', blame_or_cause: '黑市追踪者',
      controllability: '只能反向追踪争取主动', certainty: '高度确定', value_or_norm_violated: '家人不能成为交易筹码'
    },
    character_layers: {
      felt: '恐惧与愤怒', admitted: '承认母亲正处于危险', displayed: '保持冷静继续套话',
      suppressed: '对父亲的怀疑', action_impulse: '立即反向追踪'
    },
    information_position: {
      reader_knows: '追踪者掌握母亲身份', pov_knows: '父亲可能与黑市有关',
      other_knows: '追踪者知道更多旧事', gap_type: 'reader_equal'
    },
    choice_and_cost: '林舟选择反向跟踪，并承担暴露异常能力的代价',
    private_detail_anchor: '母亲死亡的威胁', subtext_or_omission: '林舟不立刻追问父亲，只继续套取敌人信息',
    reader_state_after: { label: '警觉', valence: -1, arousal: 3, agency: 0, certainty: 1 },
    arc_role: 'build', emotional_debt_opened: '父亲与黑市的旧账', emotional_debt_paid: '',
    residue_into_next: '林舟之后的选择会被对父亲的怀疑改变',
    grounding_refs: ['actor:林舟', 'pressure:pressure_black_market', 'promise:promise_ability'],
    grounded_claims: [
      { field: 'attachment_anchor', ref: 'actor:林舟', evidence: '救母亲' },
      { field: 'private_detail_anchor', ref: 'actor:林舟', evidence: '母亲死亡' }
    ]
  },
  rollingHorizon: Array.from({ length: 5 }, (_, offset) => ({
    offset,
    objective: offset === 0 ? '反向跟踪追踪者' : `继续追查黑市线索${offset}`,
    initiator: '林舟', pressureIds: ['pressure_black_market'], promiseIds: ['promise_ability'],
    expectedIrreversibleChange: `确认第${offset + 1}层线索`, replanningTrigger: '黑市压力发生变化'
  }))
}
const atomicRecord = {
  chapterId: 1,
  workId: 1,
  stateRevision: state.revision,
  status: 'planned' as const,
  plan,
  outcome: null
}
const projectedState = projectCausalOutcomeState(state, atomicRecord)
assert.deepEqual(projectedState.actors.map(item => item.name), ['林舟'])
assert.deepEqual(projectedState.activePressures.map(item => item.id), ['pressure_black_market'])
assert.deepEqual(projectedState.promises.map(item => item.id), ['promise_ability'])
assert.equal(projectedState.archivedPromiseIds.length, 0)
assert.deepEqual(projectCausalOutcomeActorPromptState(projectedState), [{
  name: '林舟',
  currentGoal: '救母亲',
  constraint: '不能直接购买寿命',
  location: '黑市入口',
  physicalState: '健康',
  knowledgeLedgerCount: 1,
  resourceLedgerCount: 1,
  relationshipLedgerCount: 1,
  obligationLedgerCount: 1
}])
const atomicClaims = buildAtomicOutcomeClaims({
  bundle: structuredClone(stagedOutcomeDraft),
  state,
  record: atomicRecord
})
assert.ok(atomicClaims.length > 10)
assert.equal(new Set(atomicClaims.map(item => item.id)).size, atomicClaims.length)
const choiceClaim = atomicClaims.find(item => item.subject === 'choice')
const costClaim = atomicClaims.find(item => item.subject === 'cost')
assert.ok(choiceClaim)
assert.ok(costClaim)
assert.ok((choiceClaim?.evidenceIds.length ?? 0) <= CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX)
assert.ok((costClaim?.evidenceIds.length ?? 0) <= CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX)
assert.equal(atomicClaims.some(item => item.subject === 'choice_and_cost'), false)
assert.ok(
  atomicClaims
    .filter(item => item.kind === 'emotion_result')
    .every(item => item.repairable),
  '情绪闭环由前置门禁保证，结果声明必须允许收窄到正文直接证据'
)
assert.equal(
  atomicClaims.some(item => item.subject === 'debt_paid'),
  false,
  '可选情绪债为空表示本章没有偿还，不能生成占位声明送入正文审计'
)
assert.ok(
  atomicClaims
    .filter(item => item.subject.endsWith(':urgency'))
    .every(item => !/变为 \d/.test(item.claim)),
  '正文证据只审计压力方向，精确紧迫度数值由结构规则校验'
)
const advancedPromiseClaim = atomicClaims.find(item => item.kind === 'promise_advance')
assert.ok(advancedPromiseClaim)
assert.equal(
  advancedPromiseClaim?.repairable,
  true,
  '冻结计划要求承诺必须推进，但推进声明应允许收窄到正文直接支持的事实'
)
assert.equal(
  atomicOutcomeClaimEvidenceText(advancedPromiseClaim!),
  advancedPromiseClaim?.value,
  '证据审计只审查承诺推进的事实值，不要求正文复述系统操作标签'
)
assert.doesNotMatch(
  atomicOutcomeClaimEvidenceText(advancedPromiseClaim!),
  /本章实质推进了读者承诺/
)
const arcAuditDraft = structuredClone(stagedOutcomeDraft)
arcAuditDraft.world.arcUpdates = [{
  id: 'arc_truth',
  status: 'active',
  claim: '林舟确认父亲曾替黑市工作',
  evidenceIds: ['e0003']
}]
const arcClaim = buildAtomicOutcomeClaims({
  bundle: arcAuditDraft,
  state,
  record: atomicRecord
}).find(item => item.kind === 'arc_state')
assert.ok(arcClaim)
assert.equal(arcClaim?.repairable, true)
assert.equal(
  atomicOutcomeClaimEvidenceText(arcClaim!),
  '林舟确认父亲曾替黑市工作',
  '阶段状态保留为结构值，正文审计只检查模型给出的直接事实'
)
assert.doesNotMatch(
  atomicOutcomeClaimEvidenceText(arcClaim!),
  /arc_truth|active|completed/
)
const newPressureAuditDraft = structuredClone(stagedOutcomeDraft)
newPressureAuditDraft.world.newPressures = [{
  key: 'land_transfer',
  source: { claim: '王长贵', evidenceIds: ['e0001'] },
  target: { claim: '林舟的八亩荒地', evidenceIds: ['e0001'] },
  condition: { claim: '流转合同正在写入该地块', evidenceIds: ['e0001'] },
  escalation: { claim: '移栽窗口只剩十八天', evidenceIds: ['e0001'] },
  urgency: {
    value: 9,
    claim: '流转合同正在写入林舟的八亩荒地',
    evidenceIds: ['e0001']
  }
}]
const newPressureUrgencyClaim = buildAtomicOutcomeClaims({
  bundle: newPressureAuditDraft,
  state,
  record: atomicRecord
}).find(item => item.subject === 'new:0:urgency')
assert.ok(newPressureUrgencyClaim)
assert.equal(newPressureUrgencyClaim?.repairable, true)
assert.equal(
  atomicOutcomeClaimEvidenceText(newPressureUrgencyClaim!),
  '流转合同正在写入林舟的八亩荒地',
  '新压力数值保留为结构值，正文审计只检查造成紧迫性的事实'
)

const twelveEvidenceUnits = buildCausalBodyEvidenceUnits(
  Array.from({ length: 12 }, (_, index) => `第${index + 1}条人物状态证据。`).join('\n')
)
const actorAtomizationDraft = structuredClone(stagedOutcomeDraft)
actorAtomizationDraft.actors.actorMutations = [
  {
    actor: '林舟', field: 'currentGoal', operation: 'set',
    value: '保护母亲并查清黑市', evidenceIds: ['e0001']
  },
  {
    actor: '林舟', field: 'knowledge', operation: 'add',
    value: '追踪者知道母亲身份', evidenceIds: ['e0002']
  },
  {
    actor: '林舟', field: 'resources', operation: 'add',
    value: '追踪者留下的通讯器', evidenceIds: ['e0003']
  },
  {
    actor: '林舟', field: 'constraint', operation: 'set',
    value: '不能让追踪者接近医院', evidenceIds: ['e0004']
  },
  {
    actor: '林舟', field: 'location', operation: 'set',
    value: '医院后巷', evidenceIds: ['e0005']
  },
  {
    actor: '林舟', field: 'relationships', operation: 'add',
    value: '开始怀疑父亲隐瞒真相', evidenceIds: ['e0006']
  },
  {
    actor: '周岚', field: 'currentGoal', operation: 'set',
    value: '抢在黑市前找到林舟', evidenceIds: ['e0007']
  },
  {
    actor: '周岚', field: 'knowledge', operation: 'add',
    value: '林舟母亲已经被盯上', evidenceIds: ['e0008']
  },
  {
    actor: '周岚', field: 'resources', operation: 'add',
    value: '医院监控记录', evidenceIds: ['e0009']
  },
  {
    actor: '周岚', field: 'constraint', operation: 'set',
    value: '调查权限将在午夜失效', evidenceIds: ['e0010']
  },
  {
    actor: '周岚', field: 'location', operation: 'set',
    value: '医院监控室', evidenceIds: ['e0011']
  },
  {
    actor: '周岚', field: 'obligations', operation: 'add',
    value: '必须保护证人身份', evidenceIds: ['e0012']
  }
]
const actorAtomizationClaims = buildAtomicOutcomeClaims({
  bundle: actorAtomizationDraft,
  state,
  record: atomicRecord
})
const actorClaims = actorAtomizationClaims.filter(item => item.kind === 'actor_state')
assert.equal(actorClaims.length, 12)
assert.ok(actorClaims.every(item => item.evidenceIds.length === 1))
const actorAtomizationMutations = materializeAtomicOutcomeClaims({
  bundle: actorAtomizationDraft,
  claims: actorAtomizationClaims,
  units: twelveEvidenceUnits
})
const actorAtomizationOutcome = materializeCausalOutcomeDraft({
  state,
  units: twelveEvidenceUnits,
  draft: actorAtomizationDraft,
  mutations: actorAtomizationMutations
})
assert.equal(actorAtomizationOutcome.actorUpdates.length, 2)
assert.deepEqual(
  actorAtomizationOutcome.actorUpdates.map(item => item.evidenceIds?.length),
  [6, 6]
)
assert.ok(actorAtomizationOutcome.mutations.every(
  item => item.evidenceIds.length <= CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX
))

const emotionAtomizationDraft = structuredClone(stagedOutcomeDraft)
emotionAtomizationDraft.emotion.choice = {
  claim: '林舟选择继续反向追踪',
  evidenceIds: ['e0001', 'e0002', 'e0003', 'e0004']
}
emotionAtomizationDraft.emotion.cost = {
  claim: '林舟为此暴露身份并失去退路',
  evidenceIds: ['e0005', 'e0006', 'e0007', 'e0008']
}
const emotionAtomizationClaims = buildAtomicOutcomeClaims({
  bundle: emotionAtomizationDraft,
  state,
  record: atomicRecord
})
const emotionChoiceClaim = emotionAtomizationClaims.find(item => item.subject === 'choice')
const emotionCostClaim = emotionAtomizationClaims.find(item => item.subject === 'cost')
assert.deepEqual(emotionChoiceClaim?.evidenceIds, ['e0001', 'e0002', 'e0003', 'e0004'])
assert.deepEqual(emotionCostClaim?.evidenceIds, ['e0005', 'e0006', 'e0007', 'e0008'])
assert.notEqual(emotionChoiceClaim?.evidencePath, emotionCostClaim?.evidencePath)
assert.equal(emotionAtomizationClaims.some(item => item.subject === 'choice_and_cost'), false)
const emotionAtomizationMutations = materializeAtomicOutcomeClaims({
  bundle: emotionAtomizationDraft,
  claims: emotionAtomizationClaims,
  units: twelveEvidenceUnits
})
const emotionAtomizationOutcome = materializeCausalOutcomeDraft({
  state,
  units: twelveEvidenceUnits,
  draft: emotionAtomizationDraft,
  mutations: emotionAtomizationMutations
})
assert.deepEqual(
  emotionAtomizationOutcome.emotionalOutcome.choiceEvidenceIds,
  ['e0001', 'e0002', 'e0003', 'e0004']
)
assert.deepEqual(
  emotionAtomizationOutcome.emotionalOutcome.costEvidenceIds,
  ['e0005', 'e0006', 'e0007', 'e0008']
)
assert.equal(
  atomicOutcomeArtifactHash(atomicClaims),
  atomicOutcomeArtifactHash(buildAtomicOutcomeClaims({
    bundle: structuredClone(stagedOutcomeDraft),
    state,
    record: atomicRecord
  }))
)
const manyEvidenceUnits = buildCausalBodyEvidenceUnits(
  Array.from({ length: 12 }, (_, index) => `第${index + 1}条独立证据。`).join('\n')
)
const tenEvidenceIds = manyEvidenceUnits.slice(0, 10).map(unit => unit.id)
const nineEvidenceIds = manyEvidenceUnits.slice(0, 9).map(unit => unit.id)
for (const modelEvidenceIds of [tenEvidenceIds, nineEvidenceIds]) {
  const atomizedCore = {
    primaryEvent: {
      claim: '第1条独立事实',
      eventSignature: '十事实原子回归',
      evidenceIds: [modelEvidenceIds[0]]
    },
    supportingEvents: modelEvidenceIds.slice(1).map((evidenceId, index) => ({
      claim: `第${index + 2}条独立事实`,
      evidenceIds: [evidenceId]
    })),
    advancedPromises: [{
      promiseId: 'promise_ability',
      claim: '第1条事实推进能力承诺',
      evidenceIds: [modelEvidenceIds[0]]
    }],
    resolvedPromises: [],
    newPromises: [],
    terminal: {
      conditionMet: false,
      matchedCondition: '',
      completionReason: '',
      evidenceIds: []
    }
  }
  assert.doesNotThrow(() => validateCausalStageEvidence(atomizedCore, manyEvidenceUnits))
}
const atomizedAggregateDraft = structuredClone(stagedOutcomeDraft)
atomizedAggregateDraft.core = {
  primaryEvent: {
    claim: '第1条独立事实',
    eventSignature: '十事实原子回归',
    evidenceIds: [tenEvidenceIds[0]]
  },
  supportingEvents: tenEvidenceIds.slice(1).map((evidenceId, index) => ({
    claim: `第${index + 2}条独立事实`,
    evidenceIds: [evidenceId]
  })),
  advancedPromises: [{
    promiseId: 'promise_ability',
    claim: '第1条事实推进能力承诺',
    evidenceIds: [tenEvidenceIds[0]]
  }],
  resolvedPromises: [],
  newPromises: [],
  terminal: {
    conditionMet: false,
    matchedCondition: '',
    completionReason: '',
    evidenceIds: []
  }
}
const independentClaims = buildAtomicOutcomeClaims({
  bundle: atomizedAggregateDraft,
  state,
  record: atomicRecord
})
const independentMutations = materializeAtomicOutcomeClaims({
  bundle: atomizedAggregateDraft,
  claims: independentClaims,
  units: manyEvidenceUnits
})
const coreMutations = independentMutations.filter(item => item.kind === 'core_summary')
assert.equal(coreMutations.length, 10)
assert.equal('evidenceIds' in atomizedAggregateDraft.core, false)
assert.ok(coreMutations.every(item => item.evidenceIds.length === 1))
const compoundCoreDraft = structuredClone(atomizedAggregateDraft)
compoundCoreDraft.core.primaryEvent = {
  claim: '林舟取出复印纸，确认许可证年份、有效期、撕毁方式和两个人的签名',
  eventSignature: '发现复合文件线索',
  evidenceIds: tenEvidenceIds.slice(0, 4)
}
const compoundClaims = buildAtomicOutcomeClaims({
  bundle: compoundCoreDraft,
  state,
  record: atomicRecord
})
const compoundPrimary = compoundClaims.find(
  item => item.claimPath === 'core.primaryEvent.claim'
)
assert.ok(compoundPrimary)
const repairedCore = applyCausalCoreSemanticRepairs({
  core: compoundCoreDraft.core,
  claims: [compoundPrimary!],
  units: manyEvidenceUnits,
  repairs: [{
    claimId: compoundPrimary!.id,
    replacement: {
      claim: '林舟取出半张复印纸',
      eventSignature: '取出半张复印纸',
      evidenceIds: [tenEvidenceIds[0]]
    },
    additionalEvents: [
      { claim: '复印纸标有许可证年份', evidenceIds: [tenEvidenceIds[1]] },
      { claim: '复印纸保留两个人的签名', evidenceIds: [tenEvidenceIds[2], tenEvidenceIds[3]] }
    ]
  }]
})
assert.equal(repairedCore.primaryEvent.claim, '林舟取出半张复印纸')
assert.deepEqual(repairedCore.primaryEvent.evidenceIds, [tenEvidenceIds[0]])
assert.equal(
  repairedCore.supportingEvents.length,
  compoundCoreDraft.core.supportingEvents.length + 2
)
assert.deepEqual(repairedCore.advancedPromises, compoundCoreDraft.core.advancedPromises)
assert.throws(
  () => applyCausalCoreSemanticRepairs({
    core: compoundCoreDraft.core,
    claims: [compoundPrimary!],
    units: manyEvidenceUnits,
    repairs: [{
      claimId: compoundPrimary!.id,
      replacement: {
        claim: '仍然聚合过多证据',
        eventSignature: '证据超限',
        evidenceIds: tenEvidenceIds.slice(0, CAUSAL_CORE_SEMANTIC_EVIDENCE_MAX + 1)
      },
      additionalEvents: []
    }]
  }),
  /需要拆分结论/
)
assert.equal(causalCandidateTotal(plan.candidates[0]), 87)
assert.deepEqual(causalChapterCountBounds(100), { min: 85, max: 115 })
const independentlyScored = materializeCausalCandidates(
  [{
    ...plan.candidates[0],
    chapterFunction: 'aftermath',
    id: undefined as never,
    scores: undefined as never
  }],
  [{
    causalNecessity: 80,
    promiseProgress: 75,
    irreversibleImpact: 35,
    novelty: 85,
    pressureEscalation: 20,
    pacingFitness: 95
  }]
)
assert.equal(independentlyScored[0].chapterFunction, 'aftermath')
assert.equal(independentlyScored[0].scores.total, 72)
const normalizedLegacyState = normalizeCausalNarrativeState({
  ...state,
  schemaVersion: 2 as never,
  lastMacroAuditChapter: undefined as never,
  actors: state.actors.map(actor => ({
    ...actor,
    location: undefined as never,
    physicalState: undefined as never,
    relationships: undefined as never,
    obligations: undefined as never
  }))
})
assert.equal(normalizedLegacyState.schemaVersion, CAUSAL_NOVEL_SCHEMA_VERSION)
assert.equal(normalizedLegacyState.lastMacroAuditChapter, 0)
assert.equal(normalizedLegacyState.actors[0].location, '未记录')
assert.deepEqual(normalizedLegacyState.actors[0].relationships, [])
const evidenceCatalog = buildCausalEvidenceCatalog(state)
const { total: _total, ...draftScores } = plan.candidates[0].scores
const { id: _candidateId, scores: _candidateScores, ...draftCandidate } = plan.candidates[0]
const {
  initiator: _initiator,
  chosenAction: _chosenAction,
  opposition: _opposition,
  cost: _cost,
  advancedPromiseIds: _advancedPromiseIds,
  newQuestion: _newQuestion,
  ...draftDecision
} = plan.decision
const {
  pov_character: _povCharacter,
  grounding_refs: _groundingRefs,
  grounded_claims: _groundedClaims,
  ...draftEmotion
} = plan.emotionContract
const causalDraft: CausalChapterPlanDraft = {
  candidates: [{ ...draftCandidate, scores: draftScores }],
  decision: draftDecision,
  emotionContract: {
    ...draftEmotion,
    groundingEvidence: {
      attachmentEvidenceId: evidenceCatalog.find(item => item.text === '救母亲')!.id,
      privateDetailEvidenceId: evidenceCatalog.find(item => item.text === '母亲死亡')!.id
    }
  },
  rollingHorizon: plan.rollingHorizon.map((item, index) => ({
    ...item,
    offset: 9 - index,
    initiator: index === 0 ? '周岚' : item.initiator
  }))
}
const materialized = materializeCausalChapterPlan(state, causalDraft, evidenceCatalog)
assert.equal(materialized.selectedCandidateId, 'candidate_1')
assert.equal(materialized.candidates[0].scores.total, 87)
assert.equal(materialized.decision.initiator, '林舟')
assert.equal(materialized.decision.chosenAction, '反向跟踪追踪者')
assert.equal(materialized.emotionContract.pov_character, '林舟')
assert.equal(materialized.emotionContract.private_detail_anchor, '母亲死亡')
assert.equal(materialized.rollingHorizon[0].offset, 0)
assert.equal(materialized.rollingHorizon[0].initiator, '林舟')
validateCausalChapterEmotionContract(state, materialized)
validateCausalChapterEmotionContract(state, plan)
assert.ok(causalEmotionGroundingRefs(state).includes('actor:林舟'))
assert.throws(
  () => validateCausalChapterEmotionContract(state, {
    ...plan, emotionContract: { ...plan.emotionContract, grounding_refs: ['actor:陆野', 'promise:promise_ability'] }
  }),
  /非权威依据/
)
assert.throws(
  () => validateCausalChapterEmotionContract(state, {
    ...plan,
    emotionContract: {
      ...plan.emotionContract,
      private_detail_anchor: '母亲死亡之外，林舟童年还曾被陌生人救过一次',
      grounded_claims: plan.emotionContract.grounded_claims.map(item =>
        item.field === 'private_detail_anchor'
          ? { ...item, evidence: '母亲死亡' }
          : item
      )
    }
  }),
  /包含过多无权威依据的补写/
)

const card = formatCausalDecisionCard(plan)
for (const tag of ['开场状态', '必须覆盖', '禁止越界', '结尾落点', '连续性约束', '情节节点']) {
  assert.ok(card.includes(`【${tag}】`), `决策卡缺少 ${tag}`)
}
assert.ok(!card.includes('关系演化'))
assert.ok(card.includes('本章情绪执行卡'))

console.log('causal novel tests passed')
