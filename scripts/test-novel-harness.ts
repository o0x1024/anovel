import assert from 'node:assert/strict'
import {
  selectRelevantStoryFacts,
  selectRelevantTimelineEvents
} from '../src/main/context/novel-memory-retrieval'
import {
  deriveChapterPatternFromOutlineDiagnosis,
  partitionStateFactsByEvidence,
  validateStateFactEvidence,
  type ExtractedMemory
} from '../src/main/context/memory-extract'
import { TARGET_WORD_PRESETS } from '../src/shared/writing-plan-presets'
import { resolveChapterCharacterNames } from '../src/main/context/character-cards'
import { selectRelevantSettingExcerpts } from '../src/main/context/chapter-execution-context'
import {
  adaptBodyStyleTextForContract,
  buildChapterExecutionContract,
  evaluateNovelQualityAcceptance,
  isBetterNovelBodyCandidate,
  isRecognizedNovelHardFail,
  splitCompoundExecutionEvent
} from '../src/shared/chapter-execution-contract'
import { QUALITY_AI_METRIC_DEFS, type QualityAiMetricKey } from '../src/shared/quality-ai-score'
import {
  buildNovelEvidenceLedger,
  novelCoverageProtocolErrors,
  normalizeNovelExecutionAssessment,
  parseNovelCoverageEvidence,
  validateNovelExecutionContract
} from '../src/main/context/goal-routine/novel-execution-gate'
import {
  isFullProseOutputStep,
  resolveLayersForStep,
  resolveStepStyleInjection
} from '../src/main/context/style-step-rules'
import {
  isBodyGenerationStep,
  shouldInjectWritingStyle
} from '../src/main/context/step-prompt-policy'
import {
  applyBodyReactionReplacementPatches,
  detectBodyReactionCliches,
  removeBodyReactionClichesDeterministically
} from '../src/main/context/anti-ai-rules'

assert(TARGET_WORD_PRESETS.includes(4_000_000))
for (const step of ['body_generation_scene', 'novel_execution_repair', 'goal_diagnose_fix', 'story_continuity_repair']) {
  assert.equal(isFullProseOutputStep(step), true)
  assert.equal(isBodyGenerationStep(step), true)
  assert.equal(shouldInjectWritingStyle(step), true)
  assert.deepEqual(resolveLayersForStep(step), ['language', 'decision', 'pacing'])
  const injection = resolveStepStyleInjection(step, '【文风要求】短句推进', null)
  assert.equal(injection.languageText, '【文风要求】短句推进')
}
assert.equal(isFullProseOutputStep('novel_execution_gate'), false)
assert.deepEqual(
  resolveChapterCharacterNames(0, { characters: '["陈凉","小满"]' }),
  ['陈凉', '小满']
)

const facts = [
  {
    chapter_id: 1,
    entity: '沈砚',
    state_key: '身份',
    value_json: '"学生"',
    transition: 'create',
    irreversible: 0,
    evidence: '我是附中的学生'
  },
  {
    chapter_id: 2,
    entity: '旧任务',
    state_key: '状态',
    value_json: '"完成"',
    transition: 'complete',
    irreversible: 1,
    evidence: '旧任务已经完成'
  },
  {
    chapter_id: 10,
    entity: '沈砚',
    state_key: '身份',
    value_json: '"调查员"',
    transition: 'update',
    irreversible: 1,
    evidence: '调查员证件压在桌上'
  },
  ...Array.from({ length: 60 }, (_, index) => ({
    chapter_id: 20 + index,
    entity: `路人${index}`,
    state_key: '位置',
    value_json: `"地点${index}"`,
    transition: 'update',
    irreversible: 0,
    evidence: `路人${index}到了地点${index}`
  }))
]

const selected = selectRelevantStoryFacts(facts, '沈砚以调查员身份进入仓库', ['沈砚'], 12)
assert(selected.some(fact => fact.entity === '沈砚' && fact.value_json.includes('调查员')))
assert(!selected.some(fact => fact.entity === '沈砚' && fact.value_json.includes('学生')))
assert(selected.length <= 12)

const timeline = Array.from({ length: 40 }, (_, index) => ({
  event_name: index === 3 ? '沈砚取得证件' : `事件${index}`,
  event_description: index === 3 ? '沈砚成为调查员' : `普通事件${index}`,
  absolute_time: null,
  relative_time: `第${index}天`
}))
const selectedTimeline = selectRelevantTimelineEvents(timeline, '沈砚使用调查员证件', ['沈砚'], 12)
assert(selectedTimeline.some(event => event.event_name === '沈砚取得证件'))
assert(selectedTimeline.some(event => event.event_name === '事件39'))
assert(selectedTimeline.length <= 12)

const extracted: ExtractedMemory = {
  foreshadowing_planted: [],
  foreshadowing_resolved: [],
  character_snapshots: [],
  timeline_events: [{ event_name: '取得证件' }],
  state_facts: [{
    entity: '沈砚',
    key: '身份',
    valueType: 'enum',
    value: '调查员',
    transition: 'update',
    irreversible: true,
    evidence: '调查员证件压在桌上'
  }]
}
assert.deepEqual(validateStateFactEvidence(extracted, '他没有解释，只把调查员证件压在桌上。'), [])
assert.match(
  validateStateFactEvidence(extracted, '桌上什么都没有。')[0],
  /不是正文原文片段/
)

const mixedEvidence: ExtractedMemory = {
  ...extracted,
  state_facts: [
    ...extracted.state_facts!,
    {
      entity: '沈砚', key: '积分', valueType: 'number', value: 10,
      transition: 'increase', evidence: '系统显示积分已经增加到十点'
    }
  ]
}
const partitioned = partitionStateFactsByEvidence(mixedEvidence, '他没有解释，只把调查员证件压在桌上。')
assert.equal(partitioned.valid.length, 1)
assert.equal(partitioned.errors.length, 1)

const fallbackPattern = deriveChapterPatternFromOutlineDiagnosis(JSON.stringify({
  dramatic_contract: { irreversible_change: '主角接下交易，不能再置身事外' },
  pattern_contract: {
    conflict_type: '生存理性与底线冲突',
    protagonist_method: '先计算代价再行动',
    antagonist_tactic: '利用诱饵转嫁风险',
    anticipated_opponent_adjustment: '发现诱饵消失后追踪痕迹',
    location_type: '危险边缘区',
    hook_type: '危机迫近',
    cost_type: '打破独行原则',
    relationship_delta: '陌生人变为交易关系',
    volume_objective_delta: '核心救援事件启动'
  },
  tension_plan: { payoff_type: 'debt' }
}))
assert.equal(fallbackPattern?.payoffType, 'debt')
assert.equal(fallbackPattern?.antagonistOutcome, '主角接下交易，不能再置身事外')

const muteContract = buildChapterExecutionContract({
  chapterId: 1,
  chapterTitle: '鼠窝边的活垃圾',
  chapterOrdinal: 1,
  volumeName: '鼠口夺食',
  outline: '【开场状态】陈凉正在翻垃圾。【必须覆盖】发现被绑的小满；小满递出铁片。【禁止越界】不得完成鼠群战斗。【结尾落点】第一只变异鼠探头。',
  characterNames: ['陈凉', '小满'],
  characterSpeechStyles: ['小满是哑巴，不会说话'],
  wordTarget: 2000
})
assert.equal(muteContract.dialogueMode, 'mute_interaction')
assert.deepEqual(muteContract.dialogueRange, [0, 10])
assert.equal(muteContract.sceneBudgets.reduce((sum, item) => sum + item.targetWords, 0), 2000)
const adaptedStyle = adaptBodyStyleTextForContract('3. 对话占比不低于50%\n其他风格规则', muteContract)
assert.doesNotMatch(adaptedStyle, /不低于50%/)
assert.match(adaptedStyle, /无声互动场景/)

const freeformContract = buildChapterExecutionContract({
  chapterId: 2,
  chapterTitle: '账本后的脚步',
  chapterOrdinal: 2,
  outline: [
    '主角冲进后院，发现掌柜正在烧毁账本。',
    '主角先从火里抢账本，没有立刻追人。',
    '翻开后才发现被烧的是一本假账。',
    '【连续性约束】承接上一章主角已经受伤、掌柜仍在后院的状态。',
    '【禁止越界】不得在本章揭露幕后主使。'
  ].join('\n'),
  characterNames: ['主角', '掌柜'],
  wordTarget: 2400
})
assert(freeformContract.requiredEvents.length >= 3)
assert(freeformContract.scenes.length >= 3)
assert.equal(freeformContract.scenes.flatMap(scene => scene.mustCover).length, freeformContract.requiredEvents.length)
assert.equal(freeformContract.scenes.reduce((sum, scene) => sum + scene.targetWords, 0), 2400)
assert.match(freeformContract.continuityConstraints, /主角已经受伤/)
assert.deepEqual(validateNovelExecutionContract(freeformContract), [])

const legacyCompoundEvent = '系统规则第一次运作，陈凉选择把袋子里所有无主垃圾当场全部回收，不留下任何能被抢走的东西，黑狗帮小弟开门搜衣柜，只看到空袋子，对陈凉“穷得叮当响”的误读，和陈凉实则已经拿到120点回收点的信息差形成反差，证明捡垃圾换资源的核心玩法可持续'
assert.equal(splitCompoundExecutionEvent(legacyCompoundEvent).length, 5)
const legacyContract = buildChapterExecutionContract({
  chapterId: 26,
  chapterTitle: '空编织袋',
  chapterOrdinal: 2,
  outline: legacyCompoundEvent,
  characterNames: ['陈凉', '黑狗帮小弟'],
  wordTarget: 2000
})
assert.equal(legacyContract.requiredEvents.length, 5)
assert.notEqual(legacyContract.openingState, legacyContract.requiredEvents[0])
assert.notEqual(legacyContract.endingState, legacyContract.requiredEvents.at(-1))
assert.equal(legacyContract.scenes.length, 5)
const legacyColonOutline = '开场状态：陈凉已喝下强化药剂。必须覆盖：陈凉计算三只变异鼠的风险后选择救人；黑狗帮把孩子当累赘，陈凉看出孩子能分拣小垃圾。禁止越界：不得让孩子当场报恩。结尾落点：三个黑狗帮小弟从巷口包抄。连续性约束：承接上一章完成首次兑换的状态。'
const legacyColonDiagnosis = JSON.stringify({
  dramatic_contract: {
    protagonist_want: '陈凉计算风险后选择出手救下孩子',
    turn: '陈凉救下孩子后发现她是哑巴，布老鼠改变了救人的意义',
    irreversible_change: '陈凉打破独行规则，接纳第一个同伴',
    payoff_or_debt: '完成首次兑换的价值兑现，留下黑狗帮包抄的新债务'
  }
})
const legacyColonContract = buildChapterExecutionContract({
  chapterId: 1260,
  chapterTitle: '第一个换',
  chapterOrdinal: 3,
  outline: legacyColonOutline,
  outlineDiagnosis: legacyColonDiagnosis,
  characterNames: ['陈凉', '小满', '黑狗帮小弟'],
  wordTarget: 2000
})
assert.equal(legacyColonContract.openingState, '陈凉已喝下强化药剂。')
assert.deepEqual(legacyColonContract.requiredEvents, [
  '陈凉计算三只变异鼠的风险后选择救人',
  '黑狗帮把孩子当累赘，陈凉看出孩子能分拣小垃圾'
])
assert.deepEqual(legacyColonContract.forbiddenEvents, ['不得让孩子当场报恩'])
assert.equal(legacyColonContract.endingState, '三个黑狗帮小弟从巷口包抄。')
assert.equal(legacyColonContract.continuityConstraints, '承接上一章完成首次兑换的状态。')
assert.deepEqual(legacyColonContract.requirements.map(item => item.id), ['R001', 'R002', 'R003', 'R004'])
assert.deepEqual(legacyColonContract.requirements.map(item => item.kind), [
  'action', 'turn', 'state_change', 'payoff_debt'
])
const coverage = parseNovelCoverageEvidence([
  {
    event: freeformContract.requiredEvents[0],
    verdict: 'covered',
    evidence: ['主角冲进后院', '发现掌柜正在烧毁账本。'],
    reason: '事件完整发生'
  },
  {
    event: freeformContract.requiredEvents[1],
    verdict: 'covered',
    evidence: ['正文中不存在的伪证据'],
    reason: '误判为覆盖'
  }
], freeformContract, '主角冲进后院，发现掌柜正在烧毁账本。')
assert.equal(coverage[0].verdict, 'covered')
assert.equal(coverage[1].verdict, 'missing')
assert(coverage.slice(2).every(item => item.verdict === 'missing'))
const redundantEvidenceCoverage = parseNovelCoverageEvidence([{
  event: freeformContract.requiredEvents[0],
  verdict: 'covered',
  evidence: ['主角冲进后院', '模型拼接出的非原文'],
  reason: '事件完整发生'
}], freeformContract, '主角冲进后院，发现掌柜正在烧毁账本。')
assert.equal(redundantEvidenceCoverage[0].verdict, 'covered')
assert.deepEqual(redundantEvidenceCoverage[0].evidence, ['主角冲进后院'])

const completeCoverageContent = freeformContract.requiredEvents.join('。')
const completeCoverageRows = freeformContract.requiredEvents.map(event => ({
  event,
  verdict: 'covered',
  evidence: [event],
  reason: '事件完整发生'
}))
assert.deepEqual(
  novelCoverageProtocolErrors(completeCoverageRows, freeformContract, completeCoverageContent),
  []
)
const malformedCoverageErrors = novelCoverageProtocolErrors([
  {
    event: freeformContract.requiredEvents[0],
    verdict: 'covered',
    evidence: ['正文里已经完整写出了这个节点'],
    reason: '存在完整内容'
  }
], freeformContract, completeCoverageContent)
assert(malformedCoverageErrors.some(error => error.includes('证据不是正文精确原句')))
assert(malformedCoverageErrors.some(error => error.includes('coverage 缺少节点')))
assert(malformedCoverageErrors.some(error => error.includes('coverage 行数应为')))

const evidenceBody = [
  '陈凉计算风险后选择出手救下孩子。',
  '孩子递出的布老鼠改变了这次救人的意义。',
  '从今天起，他不再独来独往，多了需要护着的同伴。',
  '三个黑狗帮小弟已经从巷口包抄过来。'
].join('\n')
const evidenceLedger = buildNovelEvidenceLedger(evidenceBody)
assert.deepEqual(evidenceLedger.map(item => item.id), ['C001', 'C002', 'C003', 'C004'])
const normalizedCovered = normalizeNovelExecutionAssessment({
  passed: false,
  coverage: legacyColonContract.requirements.map((requirement, index) => ({
    requirement_id: requirement.id,
    verdict: 'covered',
    evidence_ids: index === 0 ? ['C001', 'C999'] : [`C00${index + 1}`],
    reason: '正文已经完成该验收项'
  })),
  forbidden_violations: [],
  continuity_blockers: [],
  warnings: []
}, legacyColonContract, evidenceLedger, 2000)
assert.equal(normalizedCovered.passed, true)
assert.equal(normalizedCovered.evaluatorProtocolErrors, undefined)
assert.deepEqual(normalizedCovered.coverage[0].evidenceIds, ['C001'])
assert(normalizedCovered.warnings.some(item => item.includes('C999')))
assert(normalizedCovered.warnings.some(item => item.includes('顶层 passed')))

const previousOnlyEvidence = normalizeNovelExecutionAssessment({
  passed: true,
  coverage: legacyColonContract.requirements.map(requirement => ({
    requirement_id: requirement.id,
    verdict: 'covered',
    evidence_ids: ['P001'],
    reason: '错误引用上一章'
  })),
  forbidden_violations: [],
  continuity_blockers: [],
  warnings: []
}, legacyColonContract, evidenceLedger, 2000)
assert.equal(previousOnlyEvidence.passed, false)
assert(previousOnlyEvidence.evaluatorProtocolErrors?.every(item => item.includes('没有可定位的当前正文证据')))

const wordOutOfRange = normalizeNovelExecutionAssessment({
  passed: true,
  coverage: legacyColonContract.requirements.map((requirement, index) => ({
    requirement_id: requirement.id,
    verdict: 'covered',
    evidence_ids: [`C00${index + 1}`],
    reason: '正文已经完成该验收项'
  })),
  forbidden_violations: [],
  continuity_blockers: [],
  warnings: []
}, legacyColonContract, evidenceLedger, 2506)
assert.equal(wordOutOfRange.passed, false)
assert(wordOutOfRange.blockers.some(item => item.includes('2506')))

const bodyReactionSentence = '陈凉松开绳口，指节因为长时间用力泛出青白，他扶着门板站稳。'
const bodyPatch = applyBodyReactionReplacementPatches(bodyReactionSentence, [bodyReactionSentence], [{
  original: bodyReactionSentence,
  replacement: '陈凉松开绳口，他扶着门板站稳。'
}])
assert.equal(bodyPatch.applied, 1)
assert.equal(detectBodyReactionCliches(bodyPatch.content).length, 0)
const rejectedBodyPatch = applyBodyReactionReplacementPatches(bodyReactionSentence, [bodyReactionSentence], [{
  original: bodyReactionSentence,
  replacement: '陈凉松开绳口，指节发白，他扶着门板站稳。'
}])
assert.equal(rejectedBodyPatch.applied, 0)
assert.equal(rejectedBodyPatch.rejected.replacement_still_blocked, 1)
const deterministicCleanup = removeBodyReactionClichesDeterministically(bodyReactionSentence)
assert.equal(deterministicCleanup.remaining, 0)
assert.equal(deterministicCleanup.content, '陈凉松开绳口，他扶着门板站稳。')

const metricMins = Object.fromEntries(
  QUALITY_AI_METRIC_DEFS.map(metric => [metric.key, 78])
) as Record<QualityAiMetricKey, number>
const scores = QUALITY_AI_METRIC_DEFS.map(metric => ({
  key: metric.key,
  label: metric.label,
  score: metric.key === 'dialogue_density' ? 30 : metric.key === 'sentence_variation' ? 75 : 82
}))
const tolerantAcceptance = evaluateNovelQualityAcceptance({
  scoreTotal: 77,
  hardFail: false,
  items: scores,
  actualWordCount: 1900,
  qualityMin: 78,
  qualityMetricMins: metricMins,
  contract: muteContract
})
assert.equal(tolerantAcceptance.passed, true)
assert.equal(tolerantAcceptance.acceptedWithinTolerance, true)
assert(!tolerantAcceptance.blockingFailures.some(item => item.includes('对话密度')))

const severeShort = evaluateNovelQualityAcceptance({
  scoreTotal: 77,
  hardFail: false,
  items: scores,
  actualWordCount: 1200,
  qualityMin: 78,
  qualityMetricMins: metricMins,
  contract: muteContract
})
assert.equal(severeShort.passed, false)
assert(severeShort.blockingFailures.some(item => item.includes('字数严重越界')))
assert.equal(isRecognizedNovelHardFail(true, ['AI句式超过建议比例']), false)
assert.equal(isRecognizedNovelHardFail(true, ['严重违反金手指能力限制']), true)

assert.equal(isBetterNovelBodyCandidate({
  hardFail: false, blockingFailures: 1, scoreTotal: 77, wordCount: 1900, targetWords: 2000
}, {
  hardFail: false, blockingFailures: 4, scoreTotal: 68, wordCount: 1250, targetWords: 2000
}), true)

const relevantExcerpt = selectRelevantSettingExcerpts(
  '## 终局\n\n高远在第八百章发动最终计划。\n\n## 当前规则\n\n陈凉只能回收被原主人主动遗弃的物品，活物不能回收。\n\n## 后期能力\n\n全球回收会在终局解锁。',
  ['陈凉', '回收', '活物'],
  90
)
assert.match(relevantExcerpt, /活物不能回收/)
assert.doesNotMatch(relevantExcerpt, /第八百章/)
const stageFilteredExcerpt = selectRelevantSettingExcerpts(
  '第37章救下小满，关系发生变化。\n\n当前通用规则：活物不能回收。',
  ['小满', '回收'],
  120,
  1
)
assert.doesNotMatch(stageFilteredExcerpt, /第37章/)
assert.match(stageFilteredExcerpt, /活物不能回收/)

process.stdout.write('novel harness tests passed\n')
