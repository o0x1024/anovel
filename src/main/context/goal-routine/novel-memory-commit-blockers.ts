import {
  storyStateDAO,
  volumeChapterDAO
} from '../../db'
import { runConsistencyGate } from '../consistency-gate'
import { runResourceConstraintGate } from '../resource-ledger'
import { assessNovelSystemics } from './novel-systemic-gate'

export function novelMemoryCommitBlockers(workId: number, chapterId: number): string[] {
  const latest = volumeChapterDAO.getChapter(chapterId)
  const consistency = runConsistencyGate(workId, chapterId, latest?.content ?? '')
  const resource = runResourceConstraintGate(workId, chapterId)
  const fingerprintReady = storyStateDAO.listFingerprintsByWork(workId)
    .some(row => row.chapter_id === chapterId)
  const systemic = assessNovelSystemics(workId, {
    requireFingerprints: false,
    includeProseScan: true
  }).issues.filter(issue => issue.severity === 'blocker' && issue.chapterIds.includes(chapterId))
  return [...new Set([
    ...consistency.blockers.map(item => `一致性：${item}`),
    ...resource.blockers.map(item => `资源约束：${item}`),
    ...(!fingerprintReady ? ['模式指纹：章节模式指纹缺失'] : []),
    ...systemic.map(issue => [
      `跨章状态/模式[${issue.code}]：${issue.message}`,
      `证据：${issue.evidence.join('；')}`,
      `要求：${issue.recommendedAction}`
    ].join('；'))
  ])]
}
