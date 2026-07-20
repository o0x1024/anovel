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
  isRecognizedNovelHardFail
} from '../src/shared/chapter-execution-contract'
import { QUALITY_AI_METRIC_DEFS, type QualityAiMetricKey } from '../src/shared/quality-ai-score'
import {
  parseNovelCoverageEvidence,
  validateNovelExecutionContract
} from '../src/main/context/goal-routine/novel-execution-gate'

assert(TARGET_WORD_PRESETS.includes(4_000_000))
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
const coverage = parseNovelCoverageEvidence([
  {
    event: freeformContract.requiredEvents[0],
    verdict: 'covered',
    evidence: '主角冲进后院，发现掌柜正在烧毁账本。',
    reason: '事件完整发生'
  },
  {
    event: freeformContract.requiredEvents[1],
    verdict: 'covered',
    evidence: '正文中不存在的伪证据',
    reason: '误判为覆盖'
  }
], freeformContract, '主角冲进后院，发现掌柜正在烧毁账本。')
assert.equal(coverage[0].verdict, 'covered')
assert.equal(coverage[1].verdict, 'missing')
assert(coverage.slice(2).every(item => item.verdict === 'missing'))

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
