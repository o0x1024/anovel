import assert from 'node:assert/strict'
import {
  calculateNovelReleaseScore,
  novelReleaseScoreBlockers,
  planCompletedNovelReleaseWindows
} from '../src/shared/novel-release-window'

const chapters = Array.from({ length: 16 }, (_, index) => ({
  id: index + 1,
  title: `第${index + 1}章`,
  content: `正文-${index + 1}`,
  status: 'completed'
}))

assert.equal(planCompletedNovelReleaseWindows(chapters.slice(0, 7)).length, 0)
assert.deepEqual(
  planCompletedNovelReleaseWindows(chapters.slice(0, 8)).map(window => [window.startIndex, window.endIndex]),
  [[1, 8]]
)
assert.deepEqual(
  planCompletedNovelReleaseWindows(chapters).map(window => [window.startIndex, window.endIndex]),
  [[1, 8], [9, 16]]
)
assert.equal(
  planCompletedNovelReleaseWindows(chapters.map((chapter, index) => (
    index === 7 ? { ...chapter, status: 'draft' } : chapter
  ))).length,
  0,
  '第8章未提交时不得伪造首发窗口'
)

const originalHash = planCompletedNovelReleaseWindows(chapters.slice(0, 8))[0].sourceHash
const rewrittenHash = planCompletedNovelReleaseWindows(chapters.slice(0, 8).map((chapter, index) => (
  index === 3 ? { ...chapter, content: `${chapter.content}-修订` } : chapter
)))[0].sourceHash
assert.notEqual(originalHash, rewrittenHash, '任一章正文变化必须使发布快照失效')

const passed = calculateNovelReleaseScore({
  continuity: 90,
  structure: 80,
  hook: 80,
  escalationPayoff: 78,
  characterEmotion: 78,
  proseRepetition: 75,
  settingNovelty: 75
})
assert.equal(passed.overall, 80)
assert.deepEqual(novelReleaseScoreBlockers(passed), [])

const lowContinuity = calculateNovelReleaseScore({
  continuity: 84,
  structure: 100,
  hook: 100,
  escalationPayoff: 100,
  characterEmotion: 100,
  proseRepetition: 100,
  settingNovelty: 100
})
assert.ok(lowContinuity.overall > 75)
assert.match(novelReleaseScoreBlockers(lowContinuity).join('\n'), /连续性/)

const lowOverall = calculateNovelReleaseScore({
  continuity: 85,
  structure: 50,
  hook: 75,
  escalationPayoff: 50,
  characterEmotion: 50,
  proseRepetition: 70,
  settingNovelty: 50
})
assert.ok(lowOverall.overall < 75)
assert.match(novelReleaseScoreBlockers(lowOverall).join('\n'), /综合分/)

console.log('novel release window contract tests passed')
