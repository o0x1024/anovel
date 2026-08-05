import assert from 'node:assert/strict'
import type { ParsedChapter } from '../src/main/context/parse-chapters'
import {
  BEAT_CONTRACT_MAX_TOKENS,
  BEAT_SKELETON_MAX_TOKENS,
  BEAT_STAGE_MAX_ATTEMPTS,
  beatGateContractRepairIndexes,
  beatGateIssueLayer,
  beatGateIssueSignature,
  beatGateIssuesForIndex,
  beatGateNeedsSkeletonModelRepair,
  beatGateRepairIndexes,
  beatGateResolvedTargetCount,
  beatGateRecoveryForFailureCount,
  compactBeatSkeletons,
  exactStageCountError,
  mergeStoryBlueprintDiagnosis,
  mergeStagedBeat,
  sanitizeBeatSkeleton,
  storyBeatStageKey,
  storyDeterministicRepairTargets,
  synchronizeStoryBoundaryPairs
} from '../src/main/context/goal-routine/story-beat-staging'
import { normalizeTensionPlanForBeat } from '../src/main/context/goal-routine/story-genre-policy'
import { normalizeEmotionContract, validateEmotionContract } from '../src/shared/emotion-contract'
import { validateStoryBoundaryContracts } from '../src/shared/story-hard-guards'

function emotionContract(overrides: Record<string, unknown> = {}) {
  return normalizeEmotionContract({
    pov_character: '张三',
    attachment_anchor: '她不肯让母亲替自己低头',
    value_at_stake: '尊严与清白',
    reader_state_before: { label: '担忧', valence: -1, arousal: 2, agency: 0, certainty: 2 },
    trigger_event: '班主任当众要求搜包',
    character_appraisal: {
      perceived_meaning: '对方要用羞辱逼她认输',
      blame_or_cause: '苏曼妮设局',
      controllability: '可以用监控时间线反证',
      certainty: 0.9,
      value_or_norm_violated: '公平'
    },
    character_layers: {
      felt: '愤怒', admitted: '紧张', displayed: '冷静', suppressed: '委屈', action_impulse: '要求封存书包'
    },
    information_position: {
      reader_knows: '项链是栽赃', pov_knows: '书包被动过', other_knows: '监控有盲区', gap_type: 'reader_ahead'
    },
    choice_and_cost: '同意搜包但要求全程录像，承担被围观的代价',
    private_detail_anchor: '她捏紧母亲缝过的书包带',
    subtext_or_omission: '她没有说自己昨晚已备份监控',
    reader_state_after: { label: '期待反击', valence: 1, arousal: 3, agency: 2, certainty: 3 },
    arc_role: 'build',
    emotional_debt_opened: '母亲受辱的旧账',
    emotional_debt_paid: '',
    residue_into_next: '搜包结果将迫使栽赃者改变口径',
    ...overrides
  })
}

const skeleton: ParsedChapter = {
  title: '满分成绩单甩上桌',
  outline: '节点一\n节点二\n下一拍钩子：搜身诬陷',
  beat_role: 'B',
  next_hook: '谁把项链放进书包？',
  pov_mode: 'first',
  characters: '["沈知屿","苏曼妮"]'
}
const enriched: ParsedChapter = {
  title: '模型擅自改名',
  outline: '模型擅自改写事件链',
  dramatic_contract: { protagonist_want: '公开真实成绩', obstacle: '校方压制' },
  continuity_contract: { time_anchor: '公示期第1天', end_location: '教室' },
  tension_plan: { phase: '承诺与失衡', level: 7, payoff_type: 'partial' },
  emotion_contract: null,
  beat_role: 'A'
}

const merged = mergeStagedBeat(skeleton, enriched)
assert.equal(merged.title, skeleton.title)
assert.equal(merged.outline, skeleton.outline)
assert.equal(merged.beat_role, 'A')
assert.equal(merged.pov_mode, 'first')
assert.equal(merged.dramatic_contract?.obstacle, '校方压制')
assert.equal(merged.continuity_contract?.time_anchor, '公示期第1天')
assert.equal(compactBeatSkeletons([skeleton])[0].pov_mode, 'first')
const preservedDiagnosis = JSON.parse(mergeStoryBlueprintDiagnosis(JSON.stringify({
  dramatic_contract: { obstacle: '旧阻碍' },
  continuity_contract: { end_location: '三楼' },
  tension_plan: { level: 5 }
}), {
  dramatic_contract: null,
  continuity_contract: null,
  tension_plan: { phase: '承诺与失衡', level: 7, payoff_type: 'partial' },
  emotion_contract: null
}) ?? '{}')
assert.equal(preservedDiagnosis.dramatic_contract.obstacle, '旧阻碍')
assert.equal(preservedDiagnosis.continuity_contract.end_location, '三楼')
assert.equal(preservedDiagnosis.tension_plan.level, 7)

assert.deepEqual(compactBeatSkeletons([skeleton]), [{
  index: 1,
  title: skeleton.title,
  plot_outline: skeleton.outline,
  beat_role: skeleton.beat_role,
  foreshadow_target: undefined,
  next_hook: skeleton.next_hook,
  pov_mode: skeleton.pov_mode,
  characters: skeleton.characters
}])
assert.equal(exactStageCountError(5, 5, '骨架'), null)
assert.equal(exactStageCountError(4, 5, '骨架'), '骨架数量不符：期望 5，实际 4')
assert.ok(BEAT_SKELETON_MAX_TOKENS < 5000)
assert.ok(BEAT_CONTRACT_MAX_TOKENS < 5000)
assert.equal(BEAT_STAGE_MAX_ATTEMPTS, 2)
assert.deepEqual(beatGateRepairIndexes(['第15拍缺少 emotion_contract'], 15), [14])
assert.deepEqual(beatGateRepairIndexes(['第3拍与第15拍张力失衡'], 15), [2, 14])
assert.deepEqual(beatGateRepairIndexes(['第1-2拍缺少铺垫，第3、5拍事实矛盾'], 5), [0, 1, 2, 4])
assert.deepEqual(beatGateRepairIndexes(['全篇因果链断裂'], 15), [])
assert.deepEqual(beatGateIssuesForIndex(['第2拍缺情绪合同', '第4拍张力失衡', '全篇因果链断裂'], 1, 5), [
  '第2拍缺情绪合同', '全篇因果链断裂'
])
assert.equal(
  beatGateIssueSignature(['第2拍 emotion_contract 缺 certainty', '第4拍张力过高'], 5),
  '2:emotion|4:tension'
)
assert.equal(beatGateIssueLayer('第5拍 plot_outline 的触发事件缺少铺垫'), 'skeleton')
assert.equal(beatGateIssueLayer('第4拍 continuity_contract 人物认知矛盾'), 'contract')
assert.equal(beatGateNeedsSkeletonModelRepair('第5拍 plot_outline 的触发事件不合理'), true)
assert.equal(beatGateNeedsSkeletonModelRepair('第5拍（最终拍）plot_outline 含续集钩子'), false)
assert.deepEqual(beatGateContractRepairIndexes(['第3拍 continuity_contract 知识状态矛盾'], 5), [1, 2, 3])
assert.equal(beatGateResolvedTargetCount(
  ['第4拍 continuity_contract 矛盾', '第5拍最终拍有钩子'],
  ['第3拍 continuity_contract 矛盾'],
  5
), 2)
assert.equal(beatGateRecoveryForFailureCount(1), 'retry_beats')
assert.equal(beatGateRecoveryForFailureCount(2), 'rebuild_contract')
assert.equal(beatGateRecoveryForFailureCount(3), 'rebuild_engine')
assert.equal(beatGateRecoveryForFailureCount(4), 'simplify')
assert.equal(beatGateRecoveryForFailureCount(5), 'retry_beats')
assert.equal(storyBeatStageKey('同一合同', 5), storyBeatStageKey('同一合同', 5))
assert.notEqual(storyBeatStageKey('合同A', 5), storyBeatStageKey('合同B', 5))
assert.notEqual(storyBeatStageKey('同一合同', 4), storyBeatStageKey('同一合同', 5))

const unsynchronizedBoundaries: ParsedChapter[] = [
  {
    title: '第一拍',
    outline: '第一拍事件',
    continuity_contract: {
      exit_boundary: '主角在医院拿到冻结裁定，手机与录音均由主角持有',
      exit_facts: ['冻结裁定已经送达', '手机与录音均由主角持有']
    }
  },
  {
    title: '第二拍',
    outline: '第二拍事件',
    continuity_contract: {
      entry_boundary: '主角刚到医院，尚未拿到裁定',
      entry_facts: ['冻结裁定已经送达', '手机与录音均由主角持有'],
      exit_boundary: '主角完成证据公证'
    }
  },
  {
    title: '第三拍',
    outline: '第三拍事件',
    continuity_contract: {
      entry_boundary: '主角准备进行证据公证'
    }
  }
]
const synchronizedBoundaries = synchronizeStoryBoundaryPairs(unsynchronizedBoundaries)
assert.equal(
  synchronizedBoundaries[1].continuity_contract?.entry_boundary,
  synchronizedBoundaries[0].continuity_contract?.exit_boundary
)
assert.equal(
  synchronizedBoundaries[2].continuity_contract?.entry_boundary,
  synchronizedBoundaries[1].continuity_contract?.exit_boundary
)
assert.deepEqual(validateStoryBoundaryContracts(synchronizedBoundaries), [])
assert.equal(
  unsynchronizedBoundaries[1].continuity_contract?.entry_boundary,
  '主角刚到医院，尚未拿到裁定',
  '共享边界投影不得原地改写模型候选'
)
const missingAuthoritativeExit = synchronizeStoryBoundaryPairs([
  { title: '第一拍', outline: '第一拍', continuity_contract: { exit_facts: ['状态已改变'] } },
  { title: '第二拍', outline: '第二拍', continuity_contract: { entry_boundary: '模型自填边界' } }
])
assert.equal(
  validateStoryBoundaryContracts(missingAuthoritativeExit)[0]?.message,
  '第1拍 exit_boundary 与第2拍 entry_boundary 必须同时存在',
  '左拍缺失权威离场边界时禁止补造'
)
assert.deepEqual(
  storyDeterministicRepairTargets([11, 12, 13, 14, 15], [11, 12, 13, 14, 15], true),
  [11, 12, 13, 14, 15],
  '共享边界修复必须保留全部受影响节拍，禁止截断为两个目标'
)
assert.deepEqual(
  storyDeterministicRepairTargets([], [11, 12, 13, 14, 15], true),
  [11, 12, 13, 14, 15],
  '边界问题缺少精确章节映射时必须重建完整边界链'
)
assert.deepEqual(
  storyDeterministicRepairTargets([11, 12, 13], [11, 12, 13], false),
  [11, 12],
  '非边界局部问题仍限制最小修复作用域'
)

const normalizedEmotion = emotionContract()
assert.ok(normalizedEmotion)
assert.equal(normalizedEmotion.character_appraisal.certainty, '人物判断确定性等级 4/4')
assert.deepEqual(validateEmotionContract(normalizedEmotion), [])
const finalEmotion = emotionContract({ residue_into_next: '' })
assert.ok(finalEmotion)
assert.deepEqual(validateEmotionContract(finalEmotion, { isFinalBeat: true }), [])
assert.ok(validateEmotionContract(finalEmotion).includes('缺少 residue_into_next'))
const incompleteEmotion = emotionContract({
  character_layers: { felt: '愤怒', admitted: '紧张', displayed: '冷静', suppressed: '委屈', action_impulse: '' }
})
assert.ok(incompleteEmotion, '字段不完整时应保留结构化合同，交给门禁报告具体字段')
assert.ok(validateEmotionContract(incompleteEmotion).includes('缺少 action_impulse'))

const currentBeat: ParsedChapter = {
  ...merged,
  emotion_contract: normalizedEmotion,
  continuity_contract: { time_anchor: '旧时间线', end_location: '旧教室' }
}
const replacementEmotion = emotionContract({ trigger_event: '校长公布监控原片' })
assert.ok(replacementEmotion)
const targeted = mergeStagedBeat(skeleton, {
  ...enriched,
  emotion_contract: replacementEmotion,
  continuity_contract: { time_anchor: '错误的新时间线', end_location: '礼堂' }
}, {
  current: currentBeat,
  issues: ['第2拍 emotion_contract 的 certainty 缺失']
})
assert.equal(targeted.emotion_contract?.trigger_event, '校长公布监控原片')
assert.equal(targeted.continuity_contract?.time_anchor, '旧时间线')

const finalMerged = mergeStagedBeat(skeleton, {
  ...enriched,
  next_hook: '强行续集',
  dramatic_contract: { protagonist_want: '洗清污名', obstacle: '校方阻拦', next_question: '新反派是谁？' }
}, { isFinalBeat: true })
assert.equal(finalMerged.next_hook, '')
assert.equal(finalMerged.dramatic_contract?.next_question, '')

const sanitizedFinal = sanitizeBeatSkeleton({
  ...finalMerged,
  outline: '1. 核心冲突闭环\n【章末钩子】主角以后是否公开身份',
  next_hook: '主角以后如何生活？',
  dramatic_contract: { ...finalMerged.dramatic_contract, next_question: '是否还有续集？' }
}, true)
assert.equal(sanitizedFinal.outline, '1. 核心冲突闭环')
assert.equal(sanitizedFinal.next_hook, '')
assert.equal(sanitizedFinal.dramatic_contract?.next_question, '')

const normalizedTension = normalizeTensionPlanForBeat({
  tension_plan: { phase: '模型自创阶段', level: 8, payoff_type: 'none' }
}, 1, 5)
assert.deepEqual(normalizedTension.tension_plan, { phase: '蓄力与受阻', level: 7, payoff_type: 'none' })

console.log('story beat staging tests passed')
