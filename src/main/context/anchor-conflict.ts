import { anchorDAO, coreSettingDAO, volumeChapterDAO } from '../db'
import type { AnchorCreateInput } from '../db'

export interface AnchorConflict {
  severity: 'warning' | 'error'
  message: string
  source: string
}

export function detectAnchorConflicts(
  workId: number,
  input: Pick<AnchorCreateInput, 'title' | 'content' | 'type'>,
  excludeAnchorId?: number
): AnchorConflict[] {
  const conflicts: AnchorConflict[] = []
  const text = `${input.title} ${input.content}`.toLowerCase()

  const existing = anchorDAO.listByWork(workId).filter(a => a.id !== excludeAnchorId)
  for (const anchor of existing) {
    if (anchor.title === input.title) {
      conflicts.push({
        severity: 'warning',
        message: `与已有锚点「${anchor.title}」标题重复`,
        source: 'anchor'
      })
    }
    if (anchor.content === input.content) {
      conflicts.push({
        severity: 'warning',
        message: `与已有锚点「${anchor.title}」内容相同`,
        source: 'anchor'
      })
    }
  }

  const settings = coreSettingDAO.listByWork(workId)
  for (const s of settings) {
    if (!['character', 'worldview', 'conflict', 'idea'].includes(s.type)) continue
    const sample = s.content.slice(0, 200).toLowerCase()
    if (sample.length > 20 && text.includes(input.title.toLowerCase()) && s.type === 'character') {
      // opposite character trait heuristic - very simple keyword clash
      if (/不能|不可|绝不|禁止/.test(input.content) && s.content.includes(input.title)) {
        conflicts.push({
          severity: 'warning',
          message: `锚点约束可能与${s.type === 'character' ? '人设' : '设定'}中的描述存在张力，请确认`,
          source: `setting:${s.type}`
        })
      }
    }
  }

  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  for (const ch of chapters.slice(0, 20)) {
    const outline = ch.outline?.toLowerCase() ?? ''
    if (outline && input.content.length > 10 && outline.includes(input.content.slice(0, 8).toLowerCase())) {
      conflicts.push({
        severity: 'warning',
        message: `章节「${ch.title}」大纲已包含类似情节，锚点可能重复约束`,
        source: `chapter:${ch.id}`
      })
      break
    }
  }

  return conflicts
}
