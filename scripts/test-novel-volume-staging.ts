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
  shouldBlockNovelVolumeGateIssues,
  selectDeterministicNovelRepairChapterNumbers,
  selectNovelVolumeGateRepairTargets,
  validatePartialVolumePlan,
  validateUniqueChapterTitles,
  volumeGenerationProfile
} from '../src/main/context/goal-routine/novel-outline-pipeline'
import {
  CHAPTER_SKELETON_MAX_ATTEMPTS,
  CHAPTER_SKELETON_PROTOCOL_VERSION,
  CHAPTER_SKELETON_FORESHADOW_MAX_CHARS,
  RECENT_SKELETON_CONTEXT_CHAPTERS,
  buildChapterSkeletonAuthorityConstraints,
  chapterSkeletonRequestTokenBudget,
  chapterSkeletonTokenBudget,
  compactOutlineForSkeletonContext,
  compactPatternForSkeletonContext,
  materializeChapterSkeletonAuthorityLedger,
  projectChapterSkeletonDelta,
  validateChapterSkeletonAuthorityLedger
} from '../src/main/context/goal-routine/novel-chapter-skeleton-policy'
import {
  MAX_AUTO_NOVEL_REPAIR_CHAPTERS,
  classifyNovelConstructionOutputTerminal,
  capNovelAutomaticRepairTargets,
  isNovelHardBudgetExhausted,
  isNovelChapterReadyForTransition,
  isNovelChapterCheckpointFailure,
  isTerminalNovelRepairError,
  nextPhaseAfterNovelOutlineCheckpoint,
  novelPhaseFailureSignature,
  resolveNovelChapterRecoveryAction,
  resolveNovelPreparationPhase,
  selectReusableNovelExecutionCandidate,
  shouldPersistNovelExecutionCandidate,
  shouldDeferNovelChapterAcceptance,
  shouldDeferNovelQualityCandidate,
  shouldPauseForNovelConstructionOutputFailure,
  shouldRecoverNovelChapterExecutionProtocol,
  shouldPauseForReadOnlyNovelAudit
} from '../src/main/context/goal-routine/novel-goal-policy'
import {
  novelVolumeGateIssueFingerprint,
  planNovelVolumeGateRepairClusters,
  selectNovelVolumeRepairWave
} from '../src/main/context/goal-routine/novel-volume-chapter-gate'
import {
  shouldInjectTasteAndConditionRules,
  shouldInjectWritingStyle
} from '../src/main/context/step-prompt-policy'
import {
  emotionAssessmentMatchesContent,
  emotionContentHash,
  isEmotionAssessmentAcceptedForTransition
} from '../src/main/context/goal-routine/emotion-gate'
import {
  parseCachedQualityAssessment,
  serializeQualityAssessment
} from '../src/main/context/goal-routine/chapter-assessment-cache'
import {
  MAX_QUALITY_EVALUATOR_FAILURES,
  classifyQualityDiagnosisFailure,
  qualityEvaluatorFailureCode,
  shouldOpenQualityEvaluatorCircuit
} from '../src/main/context/goal-routine/quality-evaluator-policy'
import {
  NARRATIVE_MEMORY_BASE_MAX_TOKENS,
  NARRATIVE_MEMORY_MAX_TRANSPORT_ATTEMPTS,
  decideNarrativeMemoryRetry,
  narrativeMemoryTokenBudget
} from '../src/main/context/goal-routine/narrative-memory-failure'

const targetChapters = 260

assert.equal(classifyQualityDiagnosisFailure('timeout of 240000ms exceeded'), 'timeout')
assert.equal(classifyQualityDiagnosisFailure('ECONNRESET'), 'transport')
assert.equal(classifyQualityDiagnosisFailure('已取消', true), 'cancelled')
assert.equal(qualityEvaluatorFailureCode('timeout'), 'QUALITY_EVALUATOR_UNAVAILABLE')
assert.equal(qualityEvaluatorFailureCode('protocol'), 'QUALITY_EVALUATOR_PROTOCOL')
assert.equal(MAX_QUALITY_EVALUATOR_FAILURES, 2)
assert.equal(shouldOpenQualityEvaluatorCircuit({
  failureKind: 'timeout',
  consecutiveFailures: 1
}), false)
assert.equal(isNovelChapterCheckpointFailure('EMOTION_LEDGER_TRUNCATED'), true)
assert.equal(isNovelChapterCheckpointFailure('MEMORY_EXTRACT_TRANSPORT'), true)
assert.equal(isNovelChapterCheckpointFailure('QUALITY_EVALUATOR_UNAVAILABLE'), false)
assert.equal(shouldOpenQualityEvaluatorCircuit({
  failureKind: 'timeout',
  consecutiveFailures: 2
}), true)
assert.equal(shouldOpenQualityEvaluatorCircuit({
  failureKind: 'cancelled',
  consecutiveFailures: 2
}), false)
assert.equal(
  narrativeMemoryTokenBudget(1),
  NARRATIVE_MEMORY_BASE_MAX_TOKENS
)
assert.equal(
  narrativeMemoryTokenBudget(2),
  8400
)
assert.equal(
  narrativeMemoryTokenBudget(3),
  12600
)
assert.equal(NARRATIVE_MEMORY_MAX_TRANSPORT_ATTEMPTS, 2)
assert.throws(() => narrativeMemoryTokenBudget(4), /生成轮次/)
assert.equal(decideNarrativeMemoryRetry({
  failureCode: 'MEMORY_EXTRACT_TRANSPORT',
  generationAttempt: 1,
  transportAttempt: 1
}), 'retry_transport')
assert.equal(decideNarrativeMemoryRetry({
  failureCode: 'MEMORY_EXTRACT_TRANSPORT',
  generationAttempt: 1,
  transportAttempt: 2
}), 'pause')
assert.equal(decideNarrativeMemoryRetry({
  failureCode: 'MEMORY_EXTRACT_PROTOCOL',
  generationAttempt: 1,
  transportAttempt: 1
}), 'next_generation')
assert.equal(decideNarrativeMemoryRetry({
  failureCode: 'MEMORY_EXTRACT_TRUNCATED',
  generationAttempt: 2,
  transportAttempt: 1
}), 'next_generation')
assert.equal(decideNarrativeMemoryRetry({
  failureCode: 'MEMORY_EXTRACT_TRUNCATED',
  generationAttempt: 3,
  transportAttempt: 1
}), 'pause')

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
assert.equal(shouldBlockNovelVolumeGateIssues({
  score: 92,
  issues: [modelResidualIssue],
  deterministicIssueCount: 0
}), true)
assert.equal(shouldBlockNovelVolumeGateIssues({
  score: 89,
  issues: [modelResidualIssue],
  deterministicIssueCount: 0
}), true)
assert.equal(shouldBlockNovelVolumeGateIssues({
  score: 92,
  issues: [{ ...modelResidualIssue, source: 'deterministic' }],
  deterministicIssueCount: 1
}), true)
assert.equal(shouldBlockNovelVolumeGateIssues({
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
  requestedPhase: 'overall_self_check',
  settingsReady: false
}), 'materialize_settings')
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
assert.equal(NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER, Number.MAX_SAFE_INTEGER)
if (initialBudget.allowed) {
  assert.equal(checkNovelVolumeRepairBudget({
    chapterNumbers: [4],
    control: { ...initialBudget.control, rewriteCounts: { '4': 1 } }
  }).allowed, true)
  assert.equal(checkNovelVolumeRepairBudget({
    chapterNumbers: [4],
    control: { ...initialBudget.control, rewriteCounts: { '4': 2 } }
  }).allowed, true)
  assert.equal(checkNovelVolumeRepairBudget({
    chapterNumbers: [6, 7, 8, 9, 10],
    control: initialBudget.control
  }).allowed, false)
}
const rootCauseIssues = [[10], [12], [14, 15], [22], [28, 29], [31, 32], [40, 41, 42]].map(repairChapterNumbers => ({
  source: 'model' as const,
  severity: 'hard' as const,
  code: 'STATE_CONTINUITY_BREAK',
  problem: `问题${repairChapterNumbers[0]}`,
  repairChapterNumbers,
  evidence: [],
  requiredFix: '修复根因'
}))
const rootClusters = planNovelVolumeGateRepairClusters(rootCauseIssues)
assert.deepEqual(rootClusters.map(cluster => cluster.chapterNumbers), [[10], [12], [14], [22], [28], [31], [40]])
assert.deepEqual(
  planNovelVolumeGateRepairClusters([
    { ...rootCauseIssues[0], repairChapterNumbers: [10, 11] },
    { ...rootCauseIssues[1], repairChapterNumbers: [12, 13] }
  ], {
    changedChapterNumbers: [10],
    rewriteCounts: { '10': 2 },
    lastRoundVersions: []
  }).map(cluster => cluster.chapterNumbers),
  [[10], [12]]
)
const exhaustedOnlyIssue = {
  ...rootCauseIssues[0],
  repairChapterNumbers: [19],
  evidence: [{ chapterNumber: 18, quote: '前章已完成揭露' }, { chapterNumber: 19, quote: '本章重复揭露' }]
}
assert.deepEqual(
  planNovelVolumeGateRepairClusters([exhaustedOnlyIssue], {
    changedChapterNumbers: [19],
    rewriteCounts: { '19': Number.MAX_SAFE_INTEGER },
    lastRoundVersions: []
  }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]).map(cluster => cluster.chapterNumbers),
  [[18]]
)
assert.deepEqual(
  planNovelVolumeGateRepairClusters([exhaustedOnlyIssue], {
    changedChapterNumbers: [17, 18, 19, 20],
    rewriteCounts: {
      '17': Number.MAX_SAFE_INTEGER,
      '18': Number.MAX_SAFE_INTEGER,
      '19': Number.MAX_SAFE_INTEGER,
      '20': Number.MAX_SAFE_INTEGER
    },
    lastRoundVersions: []
  }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]).map(cluster => cluster.chapterNumbers),
  [[21]]
)
assert.equal(
  novelVolumeGateIssueFingerprint([exhaustedOnlyIssue]),
  novelVolumeGateIssueFingerprint([{ ...exhaustedOnlyIssue, evidence: [...exhaustedOnlyIssue.evidence].reverse() }])
)
assert.deepEqual(selectNovelVolumeRepairWave(rootClusters).map(cluster => cluster.chapterNumbers), [[10], [12], [14], [22], [28], [31]])
assert.deepEqual(selectNovelVolumeRepairWave(rootClusters, 6).map(cluster => cluster.chapterNumbers), [[40]])
assert.deepEqual(
  selectNovelVolumeRepairWave(rootClusters, 1, [10, 12, 14, 22, 28, 31]).map(cluster => cluster.chapterNumbers),
  [[12], [14], [22], [28], [31]]
)
assert.deepEqual(
  selectNovelVolumeRepairWave(rootClusters, 1, [10, 12, 14, 22, 28, 31]).map(cluster => cluster.chapterNumbers).flat(),
  [12, 14, 22, 28, 31]
)
assert.equal(checkNovelVolumeRepairBudget({
  chapterNumbers: [12, 14],
  control: {
    changedChapterNumbers: [10, 12, 14, 22, 28, 31],
    rewriteCounts: { '10': 1 },
    completedWaveCount: undefined,
    waveChapterNumbers: [10, 12, 14, 22, 28, 31],
    lastRoundVersions: []
  }
}).allowed, true)
assert.equal(checkNovelVolumeRepairBudget({
  chapterNumbers: [40],
  control: {
    changedChapterNumbers: [10, 12, 14, 22, 28, 31],
    rewriteCounts: { '10': 1, '12': 1, '14': 1, '22': 1, '28': 1, '31': 1 },
    completedWaveCount: 1,
    waveChapterNumbers: [],
    lastRoundVersions: []
  }
}).allowed, true)
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
assert.equal(
  novelPhaseFailureSignature(
    'draft_body',
    'EMOTION_LEDGER_TRUNCATED',
    '情绪账本批次 002:沈清瑶|苏菱 连续 2 次失败：finishReason=length'
  ),
  'draft_body:emotion_ledger:EMOTION_LEDGER_TRUNCATED:truncated'
)
assert.equal(
  novelPhaseFailureSignature(
    'draft_body',
    'MEMORY_EXTRACT_TRANSPORT',
    '叙事记忆提取连续3轮未通过结构与证据门禁：timeout of 120000ms exceeded'
  ),
  'draft_body:memory_extraction:MEMORY_EXTRACT_TRANSPORT:timeout'
)
assert.notEqual(
  novelPhaseFailureSignature('draft_body', 'Error', '章节情节点覆盖/衔接经过 2 轮定向修复仍未通过'),
  novelPhaseFailureSignature('draft_body', 'Error', '章节执行修复后仍有 1 处泛白类模板反应')
)
assert.notEqual(
  novelPhaseFailureSignature('draft_body', 'EVALUATOR_PROTOCOL', '章节执行评估器连续 3 次未返回可逐项验证的精确证据'),
  novelPhaseFailureSignature('draft_body', 'Error', '章节情节点覆盖/衔接经过 2 轮定向修复仍未通过')
)
assert.equal(
  novelPhaseFailureSignature(
    'draft_body',
    'QUALITY_EVALUATOR_UNAVAILABLE',
    '质量评估器连续 2 次不可用，未产生任何有效质量轮次；最后错误：timeout of 240000ms exceeded'
  ),
  'draft_body:quality_evaluator:QUALITY_EVALUATOR_UNAVAILABLE:timeout'
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
assert.doesNotMatch(skeletonSchemaText, /"const"/, '章节骨架传输 Schema 不得绑定运行时章号')
assert.doesNotMatch(skeletonSchemaText, /startChapter|endChapter|chapterNumber/, '批次范围和章号必须由系统按顺序注入')
assert.doesNotMatch(skeletonSchemaText, /"minItems":3(?:,|})|"maxItems":1(?:,|})/, '章节数量必须由业务校验，不得固化进传输 Schema')
assert.doesNotMatch(skeletonSchemaText, /outline_sections|must_cover|forbidden_boundary|"continuity_constraints"/)
assert.match(skeletonSchemaText, /required_beats/)
assert.match(skeletonSchemaText, /resolved_constraints/)
assert.match(skeletonSchemaText, /fact_changes/)
assert.doesNotMatch(skeletonSchemaText, /state_changes|fact_updates|fact_creations|"before"|new_constraints|replacement|constraint_changes/)
assert.equal(CHAPTER_SKELETON_PROTOCOL_VERSION, 9)
assert.equal(CHAPTER_SKELETON_FORESHADOW_MAX_CHARS, 120)
assert.match(skeletonSchemaText, /life_status/)
assert.doesNotMatch(skeletonSchemaText, /"rule"/)
assert.equal(CHAPTER_SKELETON_MAX_ATTEMPTS, 3)
assert.deepEqual(
  Array.from({ length: CHAPTER_SKELETON_MAX_ATTEMPTS }, (_, index) => chapterSkeletonTokenBudget(index + 1)),
  [1600, 3200, 6400]
)
assert.equal(chapterSkeletonRequestTokenBudget(2, 'OUTPUT_INVALID: Schema 校验失败'), 1600)
assert.equal(chapterSkeletonRequestTokenBudget(2, '输出达到长度上限（finishReason=length）'), 3200)
assert.equal(chapterSkeletonRequestTokenBudget(3, 'Unexpected end of JSON'), 6400)
assert.equal(chapterSkeletonRequestTokenBudget(2, 'OUTPUT_TRUNCATED: 结构化响应达到长度上限'), 3200)
assert.equal(chapterSkeletonRequestTokenBudget(3, 'OUTPUT_TRUNCATED: 结构化响应达到长度上限'), 6400)
validateUniqueChapterTitles([
  { chapterNumber: 1, title: '第1章 垃圾房的反击' },
  { chapterNumber: 2, title: '第2章 管道逃生' }
])
assert.throws(
  () => validateUniqueChapterTitles([
    { chapterNumber: 1, title: '第1章 垃圾堆里的第一桶金' },
    { chapterNumber: 2, title: '第2章 垃圾堆里的第一桶金' }
  ]),
  /章节标题重复/
)
assert.throws(
  () => validateUniqueChapterTitles(
    [{ chapterNumber: 9, title: '第9章 管道逃生' }],
    ['第2章 管道逃生']
  ),
  /章节标题重复/
)
const authorityConstraints = buildChapterSkeletonAuthorityConstraints(
  '【禁止越界】不得让刀疤死亡；不得暴露系统【连续性约束】手枪由刀疤持有；陈凉左肩带伤',
  32
)
assert.ok(authorityConstraints.every(item => /^K[0-9a-f]{12}$/.test(item.id)))
assert.equal(new Set(authorityConstraints.map(item => item.id)).size, 4)
const commaSeparatedAuthority = buildChapterSkeletonAuthorityConstraints(
  '【禁止越界】不得回收手枪，不得击杀刀疤，不得揭晓白大褂身份【连续性约束】陈凉必须持有铁钉、铁蒺藜、短撬棍，消防斧必须藏在通风管道，系统升级已完成，手枪必须由刀疤持有',
  32
)
assert.deepEqual(
  commaSeparatedAuthority.map(item => item.value),
  [
    '不得回收手枪',
    '不得击杀刀疤',
    '不得揭晓白大褂身份',
    '陈凉必须持有铁钉、铁蒺藜、短撬棍',
    '消防斧必须藏在通风管道',
    '系统升级已完成',
    '手枪必须由刀疤持有'
  ]
)
const authorityLedger = materializeChapterSkeletonAuthorityLedger(
  '【禁止越界】不得让刀疤死亡；不得暴露系统【连续性约束】手枪由刀疤持有；陈凉左肩带伤',
  32
)
validateChapterSkeletonAuthorityLedger(authorityLedger, 32)
const resolvedConstraintId = Object.values(authorityLedger.constraints)
  .find(item => item.value === '陈凉左肩带伤')!.id
const projection = projectChapterSkeletonDelta({
  opening_state: '密室中的机器人开始启动',
  required_beats: ['陈凉制作干扰器', '干扰器瘫痪机器人'],
  ending_state: '机器人瘫痪，密室外出现新信号',
  foreshadow_target: '第三台终端身份将在后续揭晓',
  fact_changes: [{ subject: '工业机器人', field: 'condition', after: '瘫痪', beat_index: 2 }],
  resolved_constraints: [{ constraint_id: resolvedConstraintId, beat_index: 1 }],
}, authorityLedger, 33)
assert.match(projection.outline, /【开场状态】密室中的机器人开始启动/)
assert.match(projection.outline, /承诺K[0-9a-f]{12}/)
assert.match(projection.outline, /F[0-9a-f]{12}@2/)
assert.doesNotMatch(projection.outline, /陈凉左肩带伤/)
assert.equal(projection.ledger.lastCommittedChapter, 33)
assert.equal(projection.ledger.revision, 1)
const robotFact = Object.values(projection.ledger.facts)
  .find(item => item.subject === '工业机器人' && item.field === 'condition')!
const updatedProjection = projectChapterSkeletonDelta({
  opening_state: '机器人瘫痪在密室中央',
  required_beats: ['陈凉拆开机器人外壳', '机器人核心被取出'],
  ending_state: '机器人被拆解，核心落入陈凉手中',
  foreshadow_target: '',
  fact_changes: [{ subject: robotFact.subject, field: robotFact.field, after: '已拆解，核心被取出', beat_index: 2 }],
  resolved_constraints: [],
}, projection.ledger, 34)
assert.match(updatedProjection.outline, /F[0-9a-f]{12}@2/)
assert.equal(updatedProjection.ledger.facts[robotFact.id]?.value, '已拆解，核心被取出')
assert.throws(() => projectChapterSkeletonDelta({
  opening_state: '开场',
  required_beats: ['行动一', '行动二'],
  ending_state: '结尾',
  foreshadow_target: '',
  fact_changes: [{ subject: '工业机器人', field: 'condition', after: '重新运行', beat_index: 1 }, { subject: '工业机器人', field: 'condition', after: '再次运行', beat_index: 2 }],
  resolved_constraints: [],
}, projection.ledger, 34), /只能操作一次/)
assert.throws(() => projectChapterSkeletonDelta({
  opening_state: '开场',
  required_beats: ['行动一', '行动二'],
  ending_state: '结尾',
  fact_changes: [{ subject: '新线索', field: 'knowledge', after: '首次出现', beat_index: 1 }],
  resolved_constraints: [{ constraint_id: 'K000000000000', beat_index: 1 }],
}, authorityLedger, 33), /不存在的权威约束 K000000000000/)
assert.equal(RECENT_SKELETON_CONTEXT_CHAPTERS, 3)
const oversizedOutline = [
  `【开场状态】${'甲'.repeat(500)}`,
  `【必须覆盖】${'乙'.repeat(500)}`,
  `【禁止越界】${'丙'.repeat(500)}`,
  `【结尾落点】${'丁'.repeat(500)}`,
  `【连续性约束】${'戊'.repeat(500)}`
].join('')
const compactedOutline = compactOutlineForSkeletonContext(oversizedOutline)
assert.ok(compactedOutline.length <= 804)
assert.match(compactedOutline, /【开场状态】/)
assert.match(compactedOutline, /【连续性约束】/)
const compactedPattern = compactPatternForSkeletonContext({
  conflict_type: '不得进入下一章上下文',
  hook_type: '钩'.repeat(500),
  relationship_delta: '关系'.repeat(500),
  volume_objective_delta: '卷目标'.repeat(500)
})
assert.equal('conflict_type' in compactedPattern, false)
assert.ok(Object.values(compactedPattern).every(value => value.length <= 140))
const contractSchemaText = JSON.stringify(chapterStructureContractSchema(1))
assert.match(contractSchemaText, /dramatic_contract/)
assert.match(contractSchemaText, /antagonist_tactic/)
assert.match(contractSchemaText, /resource_budget/)
assert.match(contractSchemaText, /"maxLength":240/)
assert.doesNotMatch(contractSchemaText, /"const"/, '章节结构合同传输 Schema 不得绑定运行时章号')
assert.doesNotMatch(contractSchemaText, /chapterNumber/, '单章结构合同不得要求模型照抄系统章号')
assert.equal(chapterStructureContractTokenBudget(1), 3200)
assert.equal(chapterStructureContractTokenBudget(2), 6400)
assert.equal(chapterStructureContractTokenBudget(3), 12800)
assert.equal(chapterStructureContractTokenBudget(4), 12800)
assert.equal(shouldPauseForNovelConstructionOutputFailure({
  phase: 'generate_beats',
  errorCode: 'OUTPUT_TRUNCATED'
}), true)
assert.deepEqual(classifyNovelConstructionOutputTerminal({
  errorCode: 'RESPONSE_PROTOCOL_EXHAUSTED',
  message: 'OUTPUT_INVALID: novel_chapter_skeleton_batch 本地 Schema 校验失败'
}), {
  action: 'chapter_skeleton_contract_terminal',
  progress: '章节骨架状态操作连续不满足合同，已保留检查点并暂停'
})
assert.equal(classifyNovelConstructionOutputTerminal({
  errorCode: 'CHAPTER_SKELETON_PROTOCOL_EXHAUSTED',
  message: 'fact_updates[0] 引用了不存在的权威事实'
}).action, 'chapter_skeleton_contract_terminal')
assert.equal(classifyNovelConstructionOutputTerminal({
  errorCode: 'OUTPUT_TRUNCATED',
  message: 'finishReason=length'
}).action, 'output_truncation_terminal')
assert.equal(shouldPauseForNovelConstructionOutputFailure({
  phase: 'generate_volumes',
  errorCode: 'OUTPUT_TRUNCATED'
}), false)
assert.equal(shouldPauseForNovelConstructionOutputFailure({
  phase: 'generate_beats',
  errorCode: 'RESPONSE_PROTOCOL_EXHAUSTED',
  message: '连续 3 次结构化输出无效：OUTPUT_INVALID: 本地 Schema 校验失败'
}), true)
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
assert.equal(isNovelHardBudgetExhausted(1000, 1000), true)
assert.equal(isNovelHardBudgetExhausted(1001, 1000), true)
assert.equal(isNovelHardBudgetExhausted(999, 1000), false)
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
const emotionBoundContent = '与情绪问题报告绑定的正文'
assert.equal(emotionAssessmentMatchesContent({
  passed: false,
  outcome_meta: {
    content_hash: emotionContentHash(emotionBoundContent),
    ledger_complete: false,
    ledger_schema_version: 2
  }
} as never, emotionBoundContent), true)
assert.equal(emotionAssessmentMatchesContent({
  passed: false,
  outcome_meta: {
    content_hash: emotionContentHash(emotionBoundContent),
    ledger_complete: false,
    ledger_schema_version: 2
  }
} as never, `${emotionBoundContent}（已修改）`), false)
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
