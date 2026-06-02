import { styleDeviationDAO, writingStyleDAO, volumeChapterDAO } from '../db'

export interface StyleStabilityItem {
  chapterId: number
  chapterTitle: string
  volumeName: string
  deviationScore: number | null
  checkTime: string | null
  status: 'stable' | 'warning' | 'unknown'
}

export interface StyleStabilityReport {
  styleName: string | null
  items: StyleStabilityItem[]
  avgDeviation: number
  driftCount: number
}

const DRIFT_THRESHOLD = 0.35

export function getStyleStabilityReport(workId: number): StyleStabilityReport {
  const styleId = writingStyleDAO.getWorkStyleId(workId)
  const style = styleId ? writingStyleDAO.getById(styleId) : undefined
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const deviations = styleDeviationDAO.listByWork(workId)

  const latestByChapter = new Map<number, { score: number; time: string }>()
  for (const d of deviations) {
    if (d.deviation_score == null) continue
    const existing = latestByChapter.get(d.chapter_id)
    if (!existing || d.check_time > existing.time) {
      latestByChapter.set(d.chapter_id, { score: d.deviation_score, time: d.check_time })
    }
  }

  const items: StyleStabilityItem[] = chapters
    .filter(c => c.content?.trim())
    .map(c => {
      const dev = latestByChapter.get(c.id)
      const score = dev?.score ?? null
      let status: StyleStabilityItem['status'] = 'unknown'
      if (score != null) status = score >= DRIFT_THRESHOLD ? 'warning' : 'stable'
      return {
        chapterId: c.id,
        chapterTitle: c.title,
        volumeName: c.volume_name,
        deviationScore: score,
        checkTime: dev?.time ?? null,
        status
      }
    })

  const scored = items.filter(i => i.deviationScore != null)
  const avgDeviation = scored.length
    ? Math.round(scored.reduce((s, i) => s + i.deviationScore!, 0) / scored.length * 100) / 100
    : 0
  const driftCount = items.filter(i => i.status === 'warning').length

  return {
    styleName: style?.name ?? null,
    items,
    avgDeviation,
    driftCount
  }
}
