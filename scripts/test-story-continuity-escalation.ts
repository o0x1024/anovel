import assert from 'node:assert/strict'
import {
  routeStoryContinuityEscalation,
  storyContinuityFingerprint
} from '../src/main/context/goal-routine/story-continuity-escalation'
import { validateStoryContinuityContracts } from '../src/shared/story-hard-guards'

const ids = [11, 12, 13, 14, 15]
const blockers = ['时间顺序冲突：距忌日还有四天，却在第二天祭母', '拉闸断网阻碍被跳过']
const fingerprint = storyContinuityFingerprint(15, blockers)
assert.equal(fingerprint, '15:OBSTACLE,TIMELINE')

const first = routeStoryContinuityEscalation(ids, 15, blockers)
assert.equal(first.mode, 'beat')
assert.deepEqual(first.targetChapterIds, [15])

const second = routeStoryContinuityEscalation(ids, 15, blockers, first)
assert.equal(second.mode, 'cluster')
assert.deepEqual(second.targetChapterIds, [14, 15])

const third = routeStoryContinuityEscalation(ids, 15, blockers, second)
assert.equal(third.mode, 'contract')
const fourth = routeStoryContinuityEscalation(ids, 15, blockers, third)
assert.equal(fourth.mode, 'engine')
assert.deepEqual(fourth.targetChapterIds, ids)
const fifth = routeStoryContinuityEscalation(ids, 15, blockers, fourth)
assert.equal(fifth.mode, 'storyline')
const sixth = routeStoryContinuityEscalation(ids, 15, blockers, fifth)
assert.equal(sixth.mode, 'pause')
assert.match(sixth.hint, /冻结当前正文和全部候选/)

assert.equal(
  storyContinuityFingerprint(15, ['时间矛盾：剩3天']),
  storyContinuityFingerprint(15, ['母亲忌日被提前到第二天'])
)

const contractIssues = validateStoryContinuityContracts([
  {
    continuity_contract: {
      entry_boundary: 'START', exit_boundary: '楼梯口/存根仍在地面',
      time_anchor: '当天上午', start_location: '一楼', end_location: '楼梯口',
      entry_facts: ['资料完整'], exit_facts: ['捐赠存根仍留在一楼地面，未捡拾转移']
    },
    tension_plan: { payoff_type: 'partial' }
  },
  {
    continuity_contract: {
      entry_boundary: '楼梯口/存根仍在地面', exit_boundary: '三楼/主角拿到信封',
      time_anchor: '紧接上一拍', elapsed_from_previous: '立即', start_location: '楼梯口', end_location: '三楼',
      entry_facts: ['主角口袋里已经有捐赠存根'], exit_facts: ['主角拿到信封'],
      opponent_action: '停职教练', opponent_reasoning: '切断证据来源',
      damage_to_protagonist: '失去证人', protagonist_adjustment: '改走公开渠道'
    },
    tension_plan: { payoff_type: 'debt' }
  },
  {
    continuity_contract: {
      entry_boundary: '三楼/主角拿到信封', exit_boundary: 'END',
      time_anchor: '当天中午', elapsed_from_previous: '一小时后', start_location: '三楼', end_location: '校门口',
      entry_facts: ['主角拿到信封'], exit_facts: ['主角离校']
    },
    tension_plan: { payoff_type: 'aftertaste' }
  }
])
assert.ok(contractIssues.some(issue => issue.includes('存根状态矛盾')))

console.log('story continuity escalation tests passed')
