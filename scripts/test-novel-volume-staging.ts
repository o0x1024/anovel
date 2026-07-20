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
  checkNovelVolumeRepairBudget,
  locateNovelVolumeGateEvidenceFragments,
  missingChapterStructureFields,
  planNovelChapterBatch,
  planNovelVolumeGateWindows,
  planNovelVolumeRanges,
  replaceUniqueRepairText,
  resolveNovelVolumeWorkflowCheckpoint,
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
  shouldPauseForReadOnlyNovelAudit
} from '../src/main/context/goal-routine/novel-goal-policy'
import {
  shouldInjectTasteAndConditionRules,
  shouldInjectWritingStyle
} from '../src/main/context/step-prompt-policy'

const targetChapters = 260
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
