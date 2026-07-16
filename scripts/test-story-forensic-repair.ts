import assert from 'node:assert/strict'
import {
  routeStoryForensicRepair,
  storyForensicFingerprint
} from '../src/main/context/goal-routine/story-forensic-repair'
import type { StoryForensicIssue } from '../src/main/context/goal-routine/story-whole-evaluator'

const chapters = [
  { id: 11, title: '第一拍' },
  { id: 12, title: '第二拍' },
  { id: 13, title: '第三拍' },
  { id: 14, title: '第四拍' }
]

function issue(overrides: Partial<StoryForensicIssue> = {}): StoryForensicIssue {
  return {
    code: 'TIMELINE_CONTRADICTION',
    scope: 'sentence',
    chapterTitles: ['第四拍'],
    repairChapterTitles: ['第四拍'],
    evidence: ['开篇后第 2 天，却称母亲忌日只剩 7 天'],
    message: '忌日时间线矛盾',
    repairable: true,
    recommendedAction: '改正第四拍的日期表述',
    ...overrides
  }
}

const first = routeStoryForensicRepair(chapters, [issue()], 1)
assert.equal(first.mode, 'dynamic')
assert.equal(first.action, 'paragraph')
assert.deepEqual(first.targetChapterIds, [14])

const second = routeStoryForensicRepair(chapters, [issue()], 2)
assert.equal(second.mode, 'dynamic')
assert.equal(second.action, 'beat')
assert.deepEqual(second.targetChapterIds, [13, 14])

assert.equal(routeStoryForensicRepair(chapters, [issue()], 3).mode, 'reset_beats')
assert.equal(routeStoryForensicRepair(chapters, [issue()], 4).mode, 'reset_engine')

const cluster = routeStoryForensicRepair(chapters, [issue({
  code: 'EVIDENCE_CHAIN_BREAK',
  scope: 'beat_cluster',
  repairChapterTitles: ['第二拍', '第四拍']
})], 1)
assert.equal(cluster.action, 'beat')
assert.deepEqual(cluster.targetChapterIds, [12, 14])

const globalIssue = issue({
  code: 'BROKEN_CLIMAX_MECHANISM',
  scope: 'story_engine',
  chapterTitles: [],
  repairChapterTitles: [],
  repairable: false
})
assert.equal(routeStoryForensicRepair(chapters, [globalIssue], 1).mode, 'retry_audit')
assert.equal(routeStoryForensicRepair(chapters, [globalIssue], 2).mode, 'reset_engine')

const evaluatorError = issue({
  code: 'FORENSIC_EVALUATOR_ERROR',
  scope: 'story_engine',
  chapterTitles: [],
  repairChapterTitles: [],
  repairable: false
})
assert.equal(routeStoryForensicRepair(chapters, [evaluatorError], 5).mode, 'retry_audit')

const mixed = routeStoryForensicRepair(chapters, [evaluatorError, issue()], 1)
assert.equal(mixed.mode, 'dynamic')
assert.deepEqual(mixed.targetChapterIds, [14])

assert.equal(
  storyForensicFingerprint([issue({ evidence: ['第 2 天，剩 7 天'] })]),
  storyForensicFingerprint([issue({ evidence: ['第 3 天，剩 6 天'] })])
)

console.log('story forensic repair tests passed')
