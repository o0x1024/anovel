import assert from 'node:assert/strict'
import type { ParsedChapter } from '../src/main/context/parse-chapters'
import {
  BEAT_CONTRACT_MAX_TOKENS,
  BEAT_SKELETON_MAX_TOKENS,
  BEAT_STAGE_MAX_ATTEMPTS,
  beatGateRecoveryForFailureCount,
  compactBeatSkeletons,
  exactStageCountError,
  mergeStoryBlueprintDiagnosis,
  mergeStagedBeat,
  storyBeatStageKey
} from '../src/main/context/goal-routine/story-beat-staging'

const skeleton: ParsedChapter = {
  title: '满分成绩单甩上桌',
  outline: '节点一\n节点二\n下一拍钩子：搜身诬陷',
  beat_role: 'B',
  next_hook: '谁把项链放进书包？',
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
assert.equal(merged.dramatic_contract?.obstacle, '校方压制')
assert.equal(merged.continuity_contract?.time_anchor, '公示期第1天')
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
  characters: skeleton.characters
}])
assert.equal(exactStageCountError(5, 5, '骨架'), null)
assert.equal(exactStageCountError(4, 5, '骨架'), '骨架数量不符：期望 5，实际 4')
assert.ok(BEAT_SKELETON_MAX_TOKENS < 5000)
assert.ok(BEAT_CONTRACT_MAX_TOKENS < 5000)
assert.equal(BEAT_STAGE_MAX_ATTEMPTS, 2)
assert.equal(beatGateRecoveryForFailureCount(1), 'retry_beats')
assert.equal(beatGateRecoveryForFailureCount(2), 'rebuild_contract')
assert.equal(beatGateRecoveryForFailureCount(3), 'rebuild_engine')
assert.equal(beatGateRecoveryForFailureCount(4), 'simplify')
assert.equal(beatGateRecoveryForFailureCount(5), 'retry_beats')
assert.equal(storyBeatStageKey('同一合同', 5), storyBeatStageKey('同一合同', 5))
assert.notEqual(storyBeatStageKey('合同A', 5), storyBeatStageKey('合同B', 5))
assert.notEqual(storyBeatStageKey('同一合同', 4), storyBeatStageKey('同一合同', 5))

console.log('story beat staging tests passed')
