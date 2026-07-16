import assert from 'node:assert/strict'
import {
  canRepairStoryContinuity,
  isStoryContinuityEvaluatorFailure,
  MAX_STORY_CONTINUITY_REPAIRS
} from '../src/main/context/goal-routine/story-continuity-repair-policy'

assert.equal(MAX_STORY_CONTINUITY_REPAIRS, 3)
assert.equal(canRepairStoryContinuity(0), true)
assert.equal(canRepairStoryContinuity(2), true)
assert.equal(canRepairStoryContinuity(3), false)

assert.equal(isStoryContinuityEvaluatorFailure(['跨拍连续性门禁无返回']), true)
assert.equal(isStoryContinuityEvaluatorFailure(['跨拍连续性门禁返回格式无效']), true)
assert.equal(isStoryContinuityEvaluatorFailure(['timeout of 240000ms exceeded']), true)
assert.equal(isStoryContinuityEvaluatorFailure(['时间顺序冲突：第二天被写成忌日']), false)
assert.equal(isStoryContinuityEvaluatorFailure([
  '跨拍连续性门禁无返回',
  '时间顺序冲突'
]), false)

console.log('story continuity repair policy tests passed')
