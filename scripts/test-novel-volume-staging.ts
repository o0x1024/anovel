import assert from 'node:assert/strict'
import {
  VOLUME_CONTEXT_CHAR_LIMIT,
  VOLUME_CONTRACT_MAX_TOKENS,
  NOVEL_SINGLE_CHAPTER_MAX_TOKENS,
  NOVEL_VOLUME_GATE_MAX_REPAIR_CLUSTER,
  NOVEL_VOLUME_GATE_MAX_REPAIRED_CHAPTERS,
  NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER,
  NOVEL_VOLUME_GATE_MAX_REPAIR_TARGETS_PER_ISSUE,
  NOVEL_VOLUME_GATE_MAX_WINDOW_SIZE,
  classifyVolumeGenerationFailure,
  chapterSkeletonBatchSchema,
  chapterStructureContractSchema,
  chapterStructureContractTokenBudget,
  checkNovelVolumeRepairBudget,
  isActionableNovelVolumeGateIssue,
  locateNovelVolumeGateEvidenceFragments,
  missingChapterStructureFields,
  planNovelChapterBatch,
  planNovelVolumeGateWindows,
  planNovelVolumeRanges,
  replaceUniqueRepairText,
  resolveNovelVolumeWorkflowCheckpoint,
  shouldDeferNovelVolumeGateIssues,
  selectDeterministicNovelRepairChapterNumbers,
  selectNovelVolumeGateRepairTargets,
  validatePartialVolumePlan,
  volumeGenerationProfile
} from '../src/main/context/goal-routine/novel-outline-pipeline'
import {
  MAX_AUTO_NOVEL_REPAIR_CHAPTERS,
  capNovelAutomaticRepairTargets,
  isNovelChapterReadyForTransition,
  isTerminalNovelRepairError,
  nextPhaseAfterNovelOutlineCheckpoint,
  novelPhaseFailureSignature,
  resolveNovelChapterRecoveryAction,
  resolveNovelPreparationPhase,
  selectReusableNovelExecutionCandidate,
  shouldPersistNovelExecutionCandidate,
  shouldContinueNovelAfterVolumeRepairBoundary,
  shouldDeferNovelChapterAcceptance,
  shouldDeferNovelQualityCandidate,
  shouldExtendNovelConstructionBudget,
  shouldPauseForNovelConstructionOutputFailure,
  shouldRecoverNovelChapterExecutionProtocol,
  shouldPauseForReadOnlyNovelAudit
} from '../src/main/context/goal-routine/novel-goal-policy'
import {
  shouldInjectTasteAndConditionRules,
  shouldInjectWritingStyle
} from '../src/main/context/step-prompt-policy'
import { isEmotionAssessmentAcceptedForTransition } from '../src/main/context/goal-routine/emotion-gate'
import {
  parseCachedQualityAssessment,
  serializeQualityAssessment
} from '../src/main/context/goal-routine/chapter-assessment-cache'

const targetChapters = 260

assert.equal(isActionableNovelVolumeGateIssue({
  code: 'STATE_CONTINUITY_BREAK',
  problem: '下一章未明确说明是同一枚孢尘弹，重复描述造成状态断层',
  requiredFix: '明确这是上一章状态的延续，避免重复描述',
  evidenceChapterNumbers: [11, 12, 13]
}), false)
assert.equal(isActionableNovelVolumeGateIssue({
  code: 'CAST_CONTINUITY_BREAK',
  problem: '没有交代尸体是否被发现',
  requiredFix: '补充尸体处理说明',
  evidenceChapterNumbers: [7, 8]
}), false)
assert.equal(isActionableNovelVolumeGateIssue({
  code: 'STATE_CONTINUITY_BREAK',
  problem: '前章明确角色死亡，后章明确角色存活，状态事实互斥',
  requiredFix: '修正后章状态以服从已冻结事实',
  evidenceChapterNumbers: [3, 8]
}), true)
assert.equal(isActionableNovelVolumeGateIssue({
  code: 'STATE_CONTINUITY_BREAK',
  problem: '单章状态描述可能存在问题',
  requiredFix: '优化描述',
  evidenceChapterNumbers: [8]
}), false)
const modelResidualIssue = {
  source: 'model' as const,
  severity: 'hard' as const,
  code: 'STATE_CONTINUITY_BREAK',
  problem: '模型残留问题',
  repairChapterNumbers: [26],
  evidence: [{ chapterNumber: 26, quote: '证据文本' }],
  requiredFix: '后续定点复核'
}
assert.equal(shouldDeferNovelVolumeGateIssues({
  score: 92,
  issues: [modelResidualIssue],
  deterministicIssueCount: 0
}), true)
assert.equal(shouldDeferNovelVolumeGateIssues({
  score: 89,
  issues: [modelResidualIssue],
  deterministicIssueCount: 0
}), true)
assert.equal(shouldDeferNovelVolumeGateIssues({
  score: 92,
  issues: [{ ...modelResidualIssue, source: 'deterministic' }],
  deterministicIssueCount: 1
}), true)
assert.equal(shouldDeferNovelVolumeGateIssues({
  score: 0,
  issues: [],
  deterministicIssueCount: 0
}), false)

const completePreparation = {
  settingsReady: true,
  characterCardsReady: true,
  emotionEngineReady: true,
  settingsGateReady: true,
  volumePlanReady: true,
  hasChapters: false
}
assert.equal(resolveNovelPreparationPhase({
  ...completePreparation,
  requestedPhase: 'goal_check',
  settingsReady: false
}), 'materialize_settings')
assert.equal(resolveNovelPreparationPhase({
  ...completePreparation,
  requestedPhase: 'generate_beats',
  characterCardsReady: false
}), 'generate_character_cards')
assert.equal(resolveNovelPreparationPhase({
  ...completePreparation,
  requestedPhase: 'generate_beats',
  volumePlanReady: false
}), 'generate_volumes')
assert.equal(resolveNovelPreparationPhase({
  ...completePreparation,
  requestedPhase: 'generate_beats'
}), 'generate_beats')
assert.equal(resolveNovelPreparationPhase({
  ...completePreparation,
  requestedPhase: 'goal_check',
  hasChapters: true,
  settingsReady: false,
  volumePlanReady: false
}), 'goal_check')

const ranges = planNovelVolumeRanges(targetChapters)
assert.equal(ranges.length, 6)
assert.deepEqual(ranges[0], { startChapter: 1, endChapter: 44 })
assert.deepEqual(ranges.at(-1), { startChapter: 218, endChapter: 260 })

// 400 万字 / 4000 字每章 = 1000 章：按现有 42 章/卷目标确定性拆成 24 卷。
const fourMillionRanges = planNovelVolumeRanges(1_000)
assert.equal(fourMillionRanges.length, 24)
assert.deepEqual(fourMillionRanges[0], { startChapter: 1, endChapter: 42 })
assert.deepEqual(fourMillionRanges.at(-1), { startChapter: 960, endChapter: 1_000 })
const volumeGateWindows = planNovelVolumeGateWindows(1, 43)
assert.deepEqual(volumeGateWindows, [
  { startChapter: 1, endChapter: 8 },
  { startChapter: 9, endChapter: 15 },
  { startChapter: 16, endChapter: 22 },
  { startChapter: 23, endChapter: 29 },
  { startChapter: 30, endChapter: 36 },
  { startChapter: 37, endChapter: 43 }
])
assert.ok(volumeGateWindows.every(range => range.endChapter - range.startChapter + 1 <= NOVEL_VOLUME_GATE_MAX_WINDOW_SIZE))
assert.ok(volumeGateWindows.every(range => range.endChapter - range.startChapter + 1 >= 6))
assert.equal(NOVEL_VOLUME_GATE_MAX_REPAIR_CLUSTER, 2)
assert.deepEqual(
  selectDeterministicNovelRepairChapterNumbers('PAYOFF_DEBT_STREAK', [15, 16, 17, 18]),
  [18]
)
assert.deepEqual(
  selectDeterministicNovelRepairChapterNumbers('REPEATED_SOLUTION', [15, 16, 17, 18]),
  [17, 18]
)
assert.deepEqual(planNovelVolumeGateWindows(9, 12), [{ startChapter: 9, endChapter: 12 }])
assert.throws(() => planNovelVolumeGateWindows(5, 4), /章节范围非法/)

// 证据范围与修改范围必须分离：25、29章可用于举证，但修复目标只选26-28章。
assert.deepEqual(selectNovelVolumeGateRepairTargets({
  repairCandidates: [26, 27, 28],
  evidenceChapterNumbers: [25, 26, 27, 28, 29],
  editableChapterNumbers: [23, 24, 25, 26, 27, 28, 29]
}), [26, 27, 28])
assert.equal(NOVEL_VOLUME_GATE_MAX_REPAIR_TARGETS_PER_ISSUE, 4)
assert.deepEqual(selectNovelVolumeGateRepairTargets({
  repairCandidates: [24, 25, 26, 27, 28, 29],
  evidenceChapterNumbers: [24, 25, 26, 27, 28, 29],
  editableChapterNumbers: [23, 24, 25, 26, 27, 28, 29]
}), [26, 27, 28, 29])
assert.deepEqual(selectNovelVolumeGateRepairTargets({
  evidenceChapterNumbers: [22, 23, 24, 25],
  editableChapterNumbers: [23, 24, 25]
}), [23, 24, 25])

// 证据必须仍然逐字可定位；只兼容弱模型用省略号拼接的同章多段原文。
const evidenceSource = '陈凉带着小满钻出浅口。三人跨过臭水沟，进入垃圾场废墟。'
assert.deepEqual(
  locateNovelVolumeGateEvidenceFragments(evidenceSource, '陈凉带着小满钻出浅口。'),
  ['陈凉带着小满钻出浅口。']
)
assert.deepEqual(
  locateNovelVolumeGateEvidenceFragments(evidenceSource, '陈凉带着小满钻出浅口……三人跨过臭水沟'),
  ['陈凉带着小满钻出浅口', '三人跨过臭水沟']
)
assert.deepEqual(
  locateNovelVolumeGateEvidenceFragments(evidenceSource, '陈凉带着小满钻出浅口……三人已经逃进城外'),
  []
)
assert.deepEqual(
  locateNovelVolumeGateEvidenceFragments(evidenceSource, '陈凉带着小满逃出去'),
  []
)

const initialBudget = checkNovelVolumeRepairBudget({ chapterNumbers: [4, 5] })
assert.equal(initialBudget.allowed, true)
assert.equal(NOVEL_VOLUME_GATE_MAX_REPAIRED_CHAPTERS, 6)
assert.equal(NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER, 1)
if (initialBudget.allowed) {
  assert.equal(checkNovelVolumeRepairBudget({
    chapterNumbers: [4],
    control: { ...initialBudget.control, rewriteCounts: { '4': 1 } }
  }).allowed, false)
  assert.equal(checkNovelVolumeRepairBudget({
    chapterNumbers: [6, 7, 8, 9, 10],
    control: initialBudget.control
  }).allowed, false)
}
assert.equal(replaceUniqueRepairText({
  chapterNumber: 14,
  field: 'outline',
  current: '小满手里有两枚玻璃刺，陈凉手里有一枚。',
  oldText: '小满手里有两枚玻璃刺',
  newText: '小满手里剩一枚玻璃刺'
}), '小满手里剩一枚玻璃刺，陈凉手里有一枚。')
assert.throws(() => replaceUniqueRepairText({
  chapterNumber: 14,
  field: 'outline',
  current: '蓝皮筋在手上，蓝皮筋在手上',
  oldText: '蓝皮筋在手上',
  newText: '蓝皮筋在鼠王尾巴上'
}), /逐字且唯一命中/)

const paraphraseFailureA = novelPhaseFailureSignature(
  'generate_beats',
  'CONTRACT_INVALID',
  '分卷「第一卷」第 23-29 章窗口门禁问题「人物数量跳变」证据无效'
)
const paraphraseFailureB = novelPhaseFailureSignature(
  'generate_beats',
  'CONTRACT_INVALID',
  '分卷「第一卷」第 23-29 章窗口门禁问题「状态连续性断裂」证据无效'
)
assert.equal(paraphraseFailureA, paraphraseFailureB)
assert.notEqual(
  paraphraseFailureA,
  novelPhaseFailureSignature('generate_beats', 'CONTRACT_INVALID', '分卷「第一卷」第 30-36 章窗口门禁问题')
)
assert.notEqual(
  novelPhaseFailureSignature('draft_body', 'Error', '连续3轮未通过质量与情绪联合门禁，质量总分72'),
  novelPhaseFailureSignature('draft_body', 'Error', '叙事记忆提取连续3轮未通过结构与证据门禁')
)
assert.notEqual(
  novelPhaseFailureSignature('draft_body', 'CONTRACT_INVALID', '章节执行合同冲突：禁止越界与必须覆盖相互矛盾'),
  novelPhaseFailureSignature('draft_body', 'Error', '连续3轮未通过质量与情绪联合门禁，质量总分72')
)
assert.notEqual(
  novelPhaseFailureSignature('draft_body', 'Error', '叙事记忆提取连续3轮未通过结构与证据门禁'),
  novelPhaseFailureSignature('draft_body', 'Error', '章节模式指纹提取失败，禁止进入下一章')
)
assert.equal(
  novelPhaseFailureSignature('draft_body', 'Error', '叙事记忆提取连续3轮失败：chapter_pattern 缺失'),
  novelPhaseFailureSignature('draft_body', 'Error', '章节模式指纹提取失败，禁止进入下一章')
)
assert.notEqual(
  novelPhaseFailureSignature('draft_body', 'Error', '章节情节点覆盖/衔接经过 2 轮定向修复仍未通过'),
  novelPhaseFailureSignature('draft_body', 'Error', '章节执行修复后仍有 1 处泛白类模板反应')
)
assert.notEqual(
  novelPhaseFailureSignature('draft_body', 'EVALUATOR_PROTOCOL', '章节执行评估器连续 3 次未返回可逐项验证的精确证据'),
  novelPhaseFailureSignature('draft_body', 'Error', '章节情节点覆盖/衔接经过 2 轮定向修复仍未通过')
)
const reusableCandidate = selectReusableNovelExecutionCandidate([
  {
    version_number: 33,
    outline: '本章大纲',
    content: '新版协议保留候选',
    word_count: 1471,
    model_type: 'novel_gate_evidence',
    generation_round: 1,
    snapshot_json: null
  },
  {
    version_number: 27,
    outline: '本章大纲',
    content: '旧协议证据误判但字数合格的候选',
    word_count: 1919,
    model_type: 'novel_execution_candidate',
    generation_round: 2,
    snapshot_json: JSON.stringify({
      gate: { blockers: ['情节缺失：必写事件；评估器给出的证据不是正文精确原句'] }
    })
  },
  {
    version_number: 31,
    outline: '本章大纲',
    content: '真实缺失事件的候选',
    word_count: 1995,
    model_type: 'novel_execution_candidate',
    generation_round: 1,
    snapshot_json: JSON.stringify({ gate: { blockers: ['情节缺失：主角没有进入垃圾场'] } })
  }
], {
  outline: '本章大纲',
  wordTarget: 2000,
  wordMin: 1800,
  wordMax: 2200
})
assert.equal(reusableCandidate?.version_number, 27)
assert.equal(shouldDeferNovelChapterAcceptance({
  score: 85,
  failureLayer: 'scene',
  hardDimensionScores: [81, 79, 88, 80, 84, 86]
}), true)
assert.equal(shouldDeferNovelChapterAcceptance({
  score: 85,
  failureLayer: 'continuity',
  hardDimensionScores: [81, 79, 88, 80, 84, 86]
}), false)
assert.equal(shouldDeferNovelChapterAcceptance({
  score: 85,
  failureLayer: 'scene',
  hardDimensionScores: [81, 64, 88, 80, 84, 86]
}), false)
assert.equal(shouldDeferNovelQualityCandidate({ score: 93, hardFail: false }), true)
assert.equal(shouldDeferNovelQualityCandidate({ score: 64, hardFail: false }), false)
assert.equal(shouldDeferNovelQualityCandidate({ score: 93, hardFail: true }), false)
const repairedFrontier = selectReusableNovelExecutionCandidate([
  {
    version_number: 4,
    outline: '本章大纲',
    content: '第二轮语义候选',
    word_count: 2440,
    model_type: 'novel_execution_candidate',
    generation_round: 2,
    snapshot_json: JSON.stringify({ gate: { coverage: [{ verdict: 'partial' }], forbiddenViolations: [] } })
  },
  {
    version_number: 5,
    outline: '本章大纲',
    content: '第三轮因证据协议暂停的最新候选',
    word_count: 2506,
    model_type: 'novel_gate_evidence',
    generation_round: 3,
    snapshot_json: JSON.stringify({ gate: { coverage: [], forbiddenViolations: [] }, evaluatorFailure: true })
  }
], {
  outline: '本章大纲',
  wordTarget: 2000,
  wordMin: 1800,
  wordMax: 2200
})
assert.equal(repairedFrontier?.version_number, 4)
assert.equal(selectReusableNovelExecutionCandidate([
  {
    version_number: 1290,
    outline: '本章大纲',
    content: '旧合同候选不得污染新合同',
    word_count: 2000,
    model_type: 'novel_execution_candidate',
    generation_round: 3,
    snapshot_json: JSON.stringify({ contractHash: 'v3', gate: { coverage: [{ verdict: 'partial' }] } })
  },
  {
    version_number: 1,
    outline: '本章大纲',
    content: '新合同候选',
    word_count: 2000,
    model_type: 'novel_execution_candidate',
    generation_round: 1,
    snapshot_json: JSON.stringify({ contractHash: 'v4', gate: { coverage: [{ verdict: 'covered' }] } })
  }
], {
  outline: '本章大纲',
  wordTarget: 2000,
  wordMin: 1800,
  wordMax: 2200,
  contractHash: 'v4'
})?.version_number, 1)
const persistedExecutionCandidates = [{
  version_number: 1,
  outline: '本章大纲',
  content: '已有候选',
  word_count: 1750,
  model_type: 'novel_execution_candidate',
  generation_round: 1,
  snapshot_json: JSON.stringify({
    contractHash: 'v4',
    gate: {
      coverage: [{ verdict: 'partial' }, { verdict: 'missing' }],
      forbiddenViolations: [{ description: '越界' }]
    }
  })
}]
assert.equal(shouldPersistNovelExecutionCandidate(persistedExecutionCandidates, {
  contractHash: 'v4', content: '已有候选', wordCount: 1750,
  wordMin: 1800, wordMax: 2200,
  coverageVerdicts: ['partial', 'missing'], forbiddenViolationCount: 1
}), false)
assert.equal(shouldPersistNovelExecutionCandidate(persistedExecutionCandidates, {
  contractHash: 'v4', content: '只换措辞但没有进步', wordCount: 1750,
  wordMin: 1800, wordMax: 2200,
  coverageVerdicts: ['partial', 'missing'], forbiddenViolationCount: 1
}), false)
assert.equal(shouldPersistNovelExecutionCandidate(persistedExecutionCandidates, {
  contractHash: 'v4', content: '覆盖程度提高', wordCount: 1750,
  wordMin: 1800, wordMax: 2200,
  coverageVerdicts: ['covered', 'missing'], forbiddenViolationCount: 1
}), true)
assert.equal(shouldPersistNovelExecutionCandidate(persistedExecutionCandidates, {
  contractHash: 'v4', content: '越界减少', wordCount: 1750,
  wordMin: 1800, wordMax: 2200,
  coverageVerdicts: ['partial', 'missing'], forbiddenViolationCount: 0
}), true)
assert.equal(shouldPersistNovelExecutionCandidate(persistedExecutionCandidates, {
  contractHash: 'v5', content: '新合同首个候选', wordCount: 1800,
  wordMin: 1800, wordMax: 2200,
  coverageVerdicts: ['missing'], forbiddenViolationCount: 0
}), true)
assert.equal(selectReusableNovelExecutionCandidate([
  {
    version_number: 1,
    outline: '另一版大纲',
    content: '不可跨大纲复用',
    word_count: 2000,
    model_type: 'novel_gate_evidence',
    snapshot_json: null
  }
], {
  outline: '当前大纲',
  wordTarget: 2000,
  wordMin: 1800,
  wordMax: 2200
}), undefined)
assert.equal(shouldRecoverNovelChapterExecutionProtocol({
  resume: true,
  phase: 'draft_body',
  savedVersion: undefined,
  currentVersion: 3
}), true)
assert.equal(shouldRecoverNovelChapterExecutionProtocol({
  resume: true,
  phase: 'draft_body',
  savedVersion: 3,
  currentVersion: 3
}), false)
assert.equal(shouldRecoverNovelChapterExecutionProtocol({
  resume: true,
  phase: 'generate_beats',
  savedVersion: 1,
  currentVersion: 3
}), false)
assert.equal(shouldRecoverNovelChapterExecutionProtocol({
  resume: false,
  phase: 'draft_body',
  savedVersion: 1,
  currentVersion: 3
}), false)
assert.equal(shouldInjectWritingStyle('goal_novel_volume_chapter_gate'), false)
assert.equal(shouldInjectTasteAndConditionRules('goal_novel_volume_chapter_gate'), false)
assert.equal(shouldInjectWritingStyle('goal_novel_volume_chapter_repair'), false)
assert.equal(shouldInjectTasteAndConditionRules('goal_novel_volume_chapter_repair'), false)

const contract = (index: number) => ({
  name: `第${index + 1}卷`,
  description: `第${index + 1}卷冲突`,
  ...ranges[index],
  objective: `目标${index + 1}`,
  midpoint: `反转${index + 1}`,
  climax: `高潮${index + 1}`,
  irreversibleCost: `代价${index + 1}`,
  nextDebt: `债务${index + 1}`,
  mustResolve: [`承诺${index + 1}`],
  mayCarryForward: [`跨卷债务${index + 1}`],
  forbiddenNewThreadsAfterChapter: ranges[index].endChapter - 5,
  protagonistEndState: [`主角状态${index + 1}`],
  antagonistEndState: [`对手状态${index + 1}`]
})

assert.deepEqual(validatePartialVolumePlan([], targetChapters), [])
const checkpoint = [contract(0), contract(1)]
assert.equal(validatePartialVolumePlan(checkpoint, targetChapters).length, 2)
assert.throws(
  () => validatePartialVolumePlan([{ ...contract(0), endChapter: 43 }], targetChapters),
  /章节范围必须是 1-44/
)
assert.throws(
  () => validatePartialVolumePlan([contract(0), { ...contract(1), name: contract(0).name }], targetChapters),
  /分卷名称重复/
)
assert.ok(VOLUME_CONTRACT_MAX_TOKENS < 5000)
assert.ok(VOLUME_CONTEXT_CHAR_LIMIT < 14000)
assert.deepEqual(volumeGenerationProfile(), {
  maxTokens: VOLUME_CONTRACT_MAX_TOKENS,
  contextChars: VOLUME_CONTEXT_CHAR_LIMIT,
  compact: false,
  failureKind: 'none'
})
assert.equal(classifyVolumeGenerationFailure('timeout of 240000ms exceeded'), 'timeout')
assert.equal(classifyVolumeGenerationFailure('Unterminated string in JSON'), 'truncated')
assert.equal(classifyVolumeGenerationFailure('finishReason=length'), 'truncated')
const timeoutProfile = volumeGenerationProfile('timeout of 240000ms exceeded')
assert.equal(timeoutProfile.compact, true)
assert.ok(timeoutProfile.contextChars < VOLUME_CONTEXT_CHAR_LIMIT)
assert.ok(timeoutProfile.maxTokens >= VOLUME_CONTRACT_MAX_TOKENS)
const truncatedProfile = volumeGenerationProfile('VOLUME_OUTPUT_TRUNCATED')
assert.equal(truncatedProfile.compact, false)
assert.ok(truncatedProfile.maxTokens > VOLUME_CONTRACT_MAX_TOKENS)

assert.deepEqual(planNovelChapterBatch(1, 44), {
  end: 3,
  maxTokens: 6000,
  contextChars: 6000,
  compact: false
})

const skeletonSchemaText = JSON.stringify(chapterSkeletonBatchSchema(1, 3))
assert.doesNotMatch(skeletonSchemaText, /emotion_contract|dramatic_contract|pattern_contract|resource_budget/)
assert.match(skeletonSchemaText, /next_hook/)
const contractSchemaText = JSON.stringify(chapterStructureContractSchema(1))
assert.match(contractSchemaText, /dramatic_contract/)
assert.match(contractSchemaText, /antagonist_tactic/)
assert.match(contractSchemaText, /resource_budget/)
assert.match(contractSchemaText, /"maxLength":240/)
assert.equal(chapterStructureContractTokenBudget(1), 3200)
assert.equal(chapterStructureContractTokenBudget(2), 6400)
assert.equal(chapterStructureContractTokenBudget(3), 12800)
assert.equal(chapterStructureContractTokenBudget(4), 12800)
assert.equal(shouldPauseForNovelConstructionOutputFailure({
  phase: 'generate_beats',
  errorCode: 'OUTPUT_TRUNCATED'
}), true)
assert.equal(shouldPauseForNovelConstructionOutputFailure({
  phase: 'generate_volumes',
  errorCode: 'OUTPUT_TRUNCATED'
}), false)
assert.deepEqual(missingChapterStructureFields({
  chapterNumber: 1,
  dramatic_contract: Object.fromEntries([
    'scene_promise', 'protagonist_want', 'obstacle', 'info_gap', 'pressure_escalation',
    'turn', 'irreversible_change', 'payoff_or_debt', 'next_question'
  ].map(key => [key, key])),
  pattern_contract: Object.fromEntries([
    'conflict_type', 'protagonist_method', 'anticipated_opponent_adjustment', 'location_type',
    'hook_type', 'cost_type', 'relationship_delta', 'volume_objective_delta'
  ].map(key => [key, key])),
  resource_budget: []
}), ['dramatic_contract.stakes', 'pattern_contract.antagonist_tactic'])
assert.deepEqual(planNovelChapterBatch(4, 44), {
  end: 4,
  maxTokens: NOVEL_SINGLE_CHAPTER_MAX_TOKENS,
  contextChars: 6000,
  compact: false
})
assert.deepEqual(planNovelChapterBatch(44, 44, 'timeout of 240000ms exceeded'), {
  end: 44,
  maxTokens: NOVEL_SINGLE_CHAPTER_MAX_TOKENS,
  contextChars: 3500,
  compact: true
})

const policyChapters = Array.from({ length: 20 }, (_, index) => ({
  id: index + 1,
  volume_id: index < 10 ? 1 : 2
}))
assert.deepEqual(
  capNovelAutomaticRepairTargets([2, 13, 17, 20], policyChapters),
  [13, 17, 20]
)
assert.equal(MAX_AUTO_NOVEL_REPAIR_CHAPTERS, 8)
assert.equal(isTerminalNovelRepairError('REPAIR_STALL'), true)
assert.equal(isTerminalNovelRepairError('REPAIR_BOUNDARY'), true)
assert.equal(isTerminalNovelRepairError('OUTPUT_INVALID'), false)
assert.equal(shouldContinueNovelAfterVolumeRepairBoundary({
  phase: 'generate_beats', errorCode: 'REPAIR_STALL', hasVolumeCheckpoint: true
}), true)
assert.equal(shouldContinueNovelAfterVolumeRepairBoundary({
  phase: 'generate_beats', errorCode: 'REPAIR_BOUNDARY', hasVolumeCheckpoint: true
}), true)
assert.equal(shouldContinueNovelAfterVolumeRepairBoundary({
  phase: 'draft_body', errorCode: 'REPAIR_STALL', hasVolumeCheckpoint: true
}), false)
assert.equal(shouldExtendNovelConstructionBudget({
  turn: 1000, maxTurns: 1000, expectedChapters: 800, outlinedChapters: 800, completedBodies: 400
}), true)
assert.equal(shouldExtendNovelConstructionBudget({
  turn: 1000, maxTurns: 1000, expectedChapters: 800, outlinedChapters: 800, completedBodies: 800
}), false)
assert.equal(shouldExtendNovelConstructionBudget({
  turn: 999, maxTurns: 1000, expectedChapters: 800, outlinedChapters: 400, completedBodies: 0
}), false)
assert.equal(shouldContinueNovelAfterVolumeRepairBoundary({
  phase: 'generate_beats', errorCode: 'REPAIR_STALL', hasVolumeCheckpoint: false
}), false)
assert.equal(isNovelChapterReadyForTransition({
  qualityReady: true,
  emotionReady: true,
  patternFingerprintReady: false
}), false)
assert.equal(isNovelChapterReadyForTransition({
  qualityReady: true,
  emotionReady: true,
  patternFingerprintReady: true
}), true)
assert.equal(resolveNovelChapterRecoveryAction({
  hasContent: false, qualityReady: false, emotionReady: false, patternFingerprintReady: false
}), 'generate')
assert.equal(resolveNovelChapterRecoveryAction({
  hasContent: true, qualityReady: true, emotionReady: false, patternFingerprintReady: false
}), 'acceptance')
assert.equal(resolveNovelChapterRecoveryAction({
  hasContent: true, qualityReady: true, emotionReady: true, patternFingerprintReady: false
}), 'memory')
assert.equal(resolveNovelChapterRecoveryAction({
  hasContent: true, qualityReady: true, emotionReady: true, patternFingerprintReady: true
}), 'complete')
assert.equal(isEmotionAssessmentAcceptedForTransition({
  passed: false,
  outcome_meta: {
    content_hash: 'hash',
    ledger_complete: true,
    ledger_schema_version: 2,
    accepted_deferred: true
  }
} as never), true)
assert.equal(isEmotionAssessmentAcceptedForTransition({
  passed: false,
  outcome_meta: {
    content_hash: 'hash',
    ledger_complete: true,
    ledger_schema_version: 2
  }
} as never), false)
const deferredQualityContent = '延后验收正文'
const deferredQuality = parseCachedQualityAssessment(serializeQualityAssessment({
  content: deferredQualityContent,
  scoreTotal: 92,
  hardFail: false,
  report: '无硬伤',
  acceptedDeferred: true
}), deferredQualityContent)
assert.equal(deferredQuality?.acceptedDeferred, true)
assert.equal(parseCachedQualityAssessment(serializeQualityAssessment({
  content: deferredQualityContent,
  scoreTotal: 92,
  hardFail: false,
  acceptedDeferred: true
}), '正文已变化'), null)
assert.deepEqual(capNovelAutomaticRepairTargets([2, 3], policyChapters), [])
assert.equal(shouldPauseForReadOnlyNovelAudit({ planComplete: true, contentComplete: true, met: false }), true)
assert.equal(shouldPauseForReadOnlyNovelAudit({ planComplete: false, contentComplete: true, met: false }), false)
assert.equal(nextPhaseAfterNovelOutlineCheckpoint({
  volumeReadyForDraft: true,
  titleHookApplied: false,
  allOutlinesComplete: false
}), 'generate_title_hook')
assert.equal(nextPhaseAfterNovelOutlineCheckpoint({
  volumeReadyForDraft: true,
  titleHookApplied: true,
  allOutlinesComplete: false
}), 'draft_body')
assert.equal(nextPhaseAfterNovelOutlineCheckpoint({
  volumeReadyForDraft: false,
  titleHookApplied: true,
  allOutlinesComplete: false
}), 'generate_beats')

const workflowPlan = [
  { ...contract(0), startChapter: 1, endChapter: 43 },
  { ...contract(1), startChapter: 44, endChapter: 86 }
]
const workflowChapters = (volumeName: string, count: number, withBody = false) =>
  Array.from({ length: count }, () => ({ volume_name: volumeName, content: withBody ? '正文' : '' }))
const firstVolumeCount = workflowPlan[0].endChapter - workflowPlan[0].startChapter + 1
const secondVolumePartial = workflowChapters(workflowPlan[1].name, 9)

// 即使误启动后已越界生成第二卷，最早未通过的第一卷门禁仍必须被重建。
assert.equal(resolveNovelVolumeWorkflowCheckpoint(
  workflowPlan,
  [...workflowChapters(workflowPlan[0].name, firstVolumeCount), ...secondVolumePartial]
).kind, 'outline_gate')

// 第一卷章节门禁通过但正文未完成时，不得继续第二卷章节情节。
assert.equal(resolveNovelVolumeWorkflowCheckpoint(
  workflowPlan,
  [...workflowChapters(workflowPlan[0].name, firstVolumeCount), ...secondVolumePartial],
  [workflowPlan[0].name]
).kind, 'draft_body')

// 正文齐全但卷末正文门禁未通过时，也必须停在第一卷检查点。
assert.equal(resolveNovelVolumeWorkflowCheckpoint(
  workflowPlan,
  [...workflowChapters(workflowPlan[0].name, firstVolumeCount, true), ...secondVolumePartial],
  [workflowPlan[0].name]
).kind, 'body_gate')

const secondVolumeCheckpoint = resolveNovelVolumeWorkflowCheckpoint(
  workflowPlan,
  [...workflowChapters(workflowPlan[0].name, firstVolumeCount, true), ...secondVolumePartial],
  [workflowPlan[0].name],
  [workflowPlan[0].name]
)
assert.equal(secondVolumeCheckpoint.kind, 'generate_outline')
if (secondVolumeCheckpoint.kind === 'generate_outline') {
  assert.equal(secondVolumeCheckpoint.volume.name, workflowPlan[1].name)
  assert.equal(secondVolumeCheckpoint.nextChapter, 53)
}

console.log('novel volume staging tests passed')
