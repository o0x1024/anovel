import { volumeChapterDAO, foreshadowingDAO, characterSnapshotDAO } from '../db'

export interface CrossChapterIssue {
  severity: 'error' | 'warning' | 'info'
  chapterId?: number
  chapterTitle?: string
  message: string
}

/** 全书级规则扫描（非 AI，基于结构化数据） */
export function scanCrossChapterConsistency(workId: number): CrossChapterIssue[] {
  const issues: CrossChapterIssue[] = []
  const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.content?.trim())

  if (chapters.length < 2) {
    return [{ severity: 'info', message: '章节不足 2 章，跳过跨章扫描' }]
  }

  const pending = foreshadowingDAO.listPending(workId)
  for (const f of pending) {
    if (!f.plant_chapter_id) continue
    const plantIdx = chapters.findIndex(c => c.id === f.plant_chapter_id)
    const chaptersSince = chapters.length - 1 - plantIdx
    if (plantIdx >= 0 && chaptersSince >= 15 && f.depth !== 'shallow') {
      issues.push({
        severity: 'warning',
        message: `伏笔「${f.description.slice(0, 30)}…」已埋设 ${chaptersSince} 章仍未回收，读者可能遗忘`
      })
    }
  }

  for (let i = 1; i < chapters.length; i++) {
    const prev = chapters[i - 1]
    const curr = chapters[i]
    const prevEnd = prev.content!.slice(-300)
    const currStart = curr.content!.slice(0, 300)
    const restart = /^(话说|且说|与此同时|另一边|时间回到|让我们|新的一天)/.test(currStart.trim())
    if (restart && !prevEnd.includes('…') && !prevEnd.includes('未完')) {
      issues.push({
        severity: 'warning',
        chapterId: curr.id,
        chapterTitle: curr.title,
        message: '开篇疑似重新开场，与上一章衔接可能断裂'
      })
    }

    const prevEmo = prev.emotion_intensity ?? 5
    const currEmo = curr.emotion_intensity ?? 5
    if (Math.abs(prevEmo - currEmo) >= 7) {
      issues.push({
        severity: 'info',
        chapterId: curr.id,
        chapterTitle: curr.title,
        message: `情绪强度从 ${prevEmo} 突变至 ${currEmo}，节奏变化极大`
      })
    }
  }

  const snapshots = characterSnapshotDAO.listCharacterNames(workId)
  for (const name of snapshots) {
    const latest = characterSnapshotDAO.getLatest(workId, name)
    if (!latest?.location) continue
    const loc = latest.location
    const appearChapters = chapters.filter(c => c.content!.includes(name))
    if (appearChapters.length >= 2) {
      const lastTwo = appearChapters.slice(-2)
      if (lastTwo[0].id !== lastTwo[1].id) {
        const gap = chapters.findIndex(c => c.id === lastTwo[1].id) - chapters.findIndex(c => c.id === lastTwo[0].id)
        if (gap > 3 && loc.includes('死') === false) {
          issues.push({
            severity: 'info',
            chapterTitle: lastTwo[1].title,
            message: `角色「${name}」间隔 ${gap} 章再次出现，最新快照位置「${loc}」请确认是否合理`
          })
        }
      }
    }
  }

  if (issues.length === 0) {
    issues.push({ severity: 'info', message: '未发现明显跨章逻辑问题' })
  }

  return issues
}
