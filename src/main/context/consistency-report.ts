import { foreshadowingDAO, characterSnapshotDAO, timelineDAO, volumeChapterDAO } from '../db'
import { anchorAlignmentDAO } from '../db'
import { getSettingsQualityStatus, getSettingsQualitySummaryForReport } from './settings-quality'

export interface ConsistencyReport {
  foreshadowing: {
    total: number
    resolved: number
    pending: number
    partial: number
    abandoned: number
    recoveryRate: number
    deepPending: number
  }
  characters: {
    trackedCount: number
    snapshotCount: number
  }
  timeline: {
    eventCount: number
  }
  chapters: {
    withContent: number
    withOutline: number
    avgEmotionIntensity: number
  }
  alignment: {
    recentChecks: number
    misalignedCount: number
  }
  settingsQuality: {
    hasCheck: boolean
    isStale: boolean
    issueCount: number
    checkedAt: string | null
  }
  settingsQualityIssues: string[]
  warnings: string[]
  rhythmHints: string[]
}

export function buildConsistencyReport(workId: number): ConsistencyReport {
  const allForeshadowing = foreshadowingDAO.listByWork(workId)
  const resolved = allForeshadowing.filter(f => f.status === 'resolved').length
  const pending = allForeshadowing.filter(f => f.status === 'pending').length
  const partial = allForeshadowing.filter(f => f.status === 'partial').length
  const abandoned = allForeshadowing.filter(f => f.status === 'abandoned').length
  const deepPending = allForeshadowing.filter(
    f => f.depth === 'deep' && (f.status === 'pending' || f.status === 'partial')
  ).length

  const totalTrackable = allForeshadowing.filter(f => f.status !== 'abandoned').length
  const recoveryRate = totalTrackable > 0 ? Math.round((resolved / totalTrackable) * 100) : 100

  const characterNames = characterSnapshotDAO.listCharacterNames(workId)
  const snapshots = characterSnapshotDAO.listByWork(workId)

  const timeline = timelineDAO.listByWork(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const withContent = chapters.filter(c => c.content?.trim()).length
  const withOutline = chapters.filter(c => c.outline?.trim()).length
  const intensities = chapters
    .map(c => c.emotion_intensity ?? 5)
    .filter(v => v > 0)
  const avgEmotionIntensity = intensities.length
    ? Math.round(intensities.reduce((a, b) => a + b, 0) / intensities.length * 10) / 10
    : 5

  const alignmentLogs = anchorAlignmentDAO.latestByWork(workId)
  const misalignedCount = alignmentLogs.filter(l => !l.aligned).length

  const warnings: string[] = []
  if (pending + partial > 0 && withContent >= 3) {
    warnings.push(`有 ${pending + partial} 条伏笔待回收，请检查是否遗漏`)
  }
  if (deepPending > 0) {
    warnings.push(`有 ${deepPending} 条深伏笔尚未回收，优先级较高`)
  }
  if (characterNames.length === 0 && withContent >= 2) {
    warnings.push('尚未记录角色状态快照，长篇一致性风险较高')
  }
  if (timeline.length === 0 && withContent >= 3) {
    warnings.push('尚未建立故事时间线，可能出现时间矛盾')
  }
  if (recoveryRate < 50 && totalTrackable >= 3) {
    warnings.push(`伏笔回收率仅 ${recoveryRate}%，建议推进回收`)
  }

  const rhythmHints = analyzeEmotionRhythm(chapters)

  const qualitySummary = getSettingsQualitySummaryForReport(workId)
  const qualityStatus = getSettingsQualityStatus(workId)
  warnings.push(...qualitySummary.warnings)
  for (const issue of qualityStatus.unresolvedIssues.slice(0, 5)) {
    warnings.push(`设定自检：${issue}`)
  }

  return {
    foreshadowing: {
      total: allForeshadowing.length,
      resolved,
      pending,
      partial,
      abandoned,
      recoveryRate,
      deepPending
    },
    characters: {
      trackedCount: characterNames.length,
      snapshotCount: snapshots.length
    },
    timeline: { eventCount: timeline.length },
    chapters: { withContent, withOutline, avgEmotionIntensity },
    alignment: { recentChecks: alignmentLogs.length, misalignedCount },
    settingsQuality: {
      hasCheck: qualitySummary.hasCheck,
      isStale: qualitySummary.isStale,
      issueCount: qualitySummary.issueCount,
      checkedAt: qualitySummary.checkedAt
    },
    settingsQualityIssues: qualityStatus.unresolvedIssues,
    warnings,
    rhythmHints
  }
}

function analyzeEmotionRhythm(
  chapters: { emotion_intensity: number | null; content: string | null; title: string }[]
): string[] {
  const hints: string[] = []
  const withContent = chapters.filter(c => c.content?.trim())
  if (withContent.length < 3) return hints

  const intensities = withContent.map(c => c.emotion_intensity ?? 5)

  for (let i = 2; i < intensities.length; i++) {
    const window = intensities.slice(i - 2, i + 1)
    const max = Math.max(...window)
    const min = Math.min(...window)
    if (max - min < 2) {
      hints.push(`第 ${i - 1}–${i + 1} 章情绪强度波动过小（${window.join('/')}），建议增加起伏`)
      break
    }
  }

  let lowStreak = 0
  for (let i = 0; i < intensities.length; i++) {
    if (intensities[i] <= 4) lowStreak++
    else lowStreak = 0
    if (lowStreak >= 5) {
      hints.push('连续 5 章情绪强度偏低，读者可能感到压抑过久，建议安排释放或反转')
      break
    }
  }

  let highStreak = 0
  for (const v of intensities) {
    if (v >= 8) highStreak++
    else highStreak = 0
    if (highStreak >= 3) {
      hints.push('连续 3 章高强度爆发，读者可能疲劳，建议插入缓冲章节')
      break
    }
  }

  return hints
}
