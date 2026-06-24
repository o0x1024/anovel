import { foreshadowingDAO, characterSnapshotDAO, timelineDAO, volumeChapterDAO, anchorDAO } from '../db'
import { coreSettingDAO } from '../db'
import { formatCharacterCardsForChapter } from './character-cards'
import { getPreviousChapterContext } from './chapter-continuity'
import { MAX_ACTIVE_ANCHORS } from './writing-techniques'

const DEPTH_LABELS: Record<string, string> = {
  shallow: '浅伏笔',
  normal: '普通',
  deep: '深伏笔'
}

const BEAT_ROLE_LABELS: Record<string, string> = {
  A: '爽点释放',
  B: '进行中',
  C: '铺垫下一爽点',
  transition: '过渡缓冲'
}

export interface NarrativeMemorySections {
  chapterMeta: string
  foreshadowing: string
  snapshots: string
  timeline: string
  worldview: string
}

export interface NarrativeMemoryResult {
  text: string
  sections: NarrativeMemorySections
  pendingForeshadowingCount: number
  snapshotCharacterCount: number
  timelineEventCount: number
  characterCardsText: string
}

export interface NarrativeMemoryBuildOptions {
  /** 是否在 chapterMeta 中注入完整章节大纲（正文生成时 false，避免与 task prompt 重复） */
  includeChapterOutline?: boolean
}

/** 构建叙事记忆体各分段（不含上一章全文，由 continuity 单独注入） */
export function buildNarrativeMemorySections(
  workId: number,
  chapterId?: number,
  options: NarrativeMemoryBuildOptions = {}
): NarrativeMemoryResult {
  const { includeChapterOutline = true } = options
  const empty: NarrativeMemorySections = {
    chapterMeta: '',
    foreshadowing: '',
    snapshots: '',
    timeline: '',
    worldview: ''
  }

  let characterCardsText = ''
  let pendingForeshadowingCount = 0
  let snapshotCharacterCount = 0
  let timelineEventCount = 0
  const sections = { ...empty }

  if (chapterId) {
    const ch = volumeChapterDAO.getChapter(chapterId)
    if (ch) {
      characterCardsText = formatCharacterCardsForChapter(workId)
      const metaParts: string[] = []
      if (characterCardsText) metaParts.push(characterCardsText)

      const abcParts: string[] = []
      if (ch.beat_role) {
        abcParts.push(`爽点链角色：${ch.beat_role}（${BEAT_ROLE_LABELS[ch.beat_role] || ch.beat_role}）`)
      }
      if (ch.foreshadow_target?.trim()) abcParts.push(`铺垫目标：${ch.foreshadow_target.trim()}`)
      if (ch.next_hook?.trim()) abcParts.push(`章末钩子目标（必须落实）：${ch.next_hook.trim()}——本章结尾必须体现此悬念，禁止平淡收束`)
      if (abcParts.length) metaParts.push('【本章节奏定位】', abcParts.join('\n'))

      if (ch.pov_mode) {
        const povLabels: Record<string, string> = {
          third_limited: '第三人称限知（跟随单一视角，禁止随意切换）',
          first: '第一人称',
          omniscient: '第三人称全知'
        }
        metaParts.push('【叙事视角】', povLabels[ch.pov_mode] || ch.pov_mode)
      }

      if (includeChapterOutline && ch.outline?.trim()) {
        metaParts.push('【当前章节大纲】', ch.outline)
      }
      sections.chapterMeta = metaParts.join('\n\n')
    }
  }

  const pending = foreshadowingDAO.listPending(workId)
  pendingForeshadowingCount = pending.length
  if (pending.length > 0) {
    sections.foreshadowing = [
      '【待回收伏笔 - 本章应适当推进或回收】',
      ...pending.map((f, i) => {
        const depth = DEPTH_LABELS[f.depth || 'normal'] || '普通'
        const loc = f.plant_location ? `（埋设于：${f.plant_location}）` : ''
        return `${i + 1}. [${depth}] ${f.description}${loc}`
      })
    ].join('\n')
  }

  const allSnapshotNames = characterSnapshotDAO.listCharacterNames(workId)
  const snapshots = allSnapshotNames
    .map(name => characterSnapshotDAO.getLatest(workId, name))
    .filter((s): s is NonNullable<typeof s> => !!s)
  snapshotCharacterCount = snapshots.length
  if (snapshots.length > 0) {
    sections.snapshots = [
      '【角色当前状态快照 - 出场角色须与此一致】',
      ...snapshots.map(s => {
        const parts = [
          `角色：${s.character_name}`,
          s.location ? `位置：${s.location}` : '',
          s.mental_state ? `心理：${s.mental_state}` : '',
          s.known_info ? `已知信息：${s.known_info}` : '',
          s.relationship_changes ? `关系变化：${s.relationship_changes}` : '',
          s.ability_changes ? `能力/资源：${s.ability_changes}` : ''
        ].filter(Boolean)
        return `- ${parts.join(' | ')}`
      })
    ].join('\n')
  }

  const timeline = timelineDAO.listByWork(workId)
  timelineEventCount = timeline.length
  if (timeline.length > 0) {
    sections.timeline = [
      '【故事时间线约束】',
      ...timeline.map(e => {
        const time = e.absolute_time || e.relative_time || '未标注时间'
        const ch = e.chapter_id ? `（章节#${e.chapter_id}）` : ''
        return `- [${time}] ${e.event_name}${ch}${e.event_description ? '：' + e.event_description : ''}`
      })
    ].join('\n')
  }

  const worldview = coreSettingDAO.getByType(workId, 'worldview')?.content?.trim()
  if (worldview) {
    sections.worldview = ['【世界观规则 - 不可违反】', worldview].join('\n')
  }

  const joined = [
    sections.chapterMeta,
    sections.foreshadowing,
    sections.snapshots,
    sections.timeline,
    sections.worldview
  ].filter(Boolean)

  const text = joined.length > 0 ? ['【叙事记忆体】', ...joined].join('\n\n') : ''

  return {
    text,
    sections,
    pendingForeshadowingCount,
    snapshotCharacterCount,
    timelineEventCount,
    characterCardsText
  }
}

/** 兼容旧 IPC：返回合并文本 + 统计 + 上一章衔接信息 */
export function buildNarrativeMemoryPrompt(workId: number, chapterId?: number): NarrativeMemoryResult & {
  hasPreviousChapter: boolean
  previousChapterTitle: string | null
  previousChapterContent: string
  previousChapterCharCount: number
  anchorLimitWarning: string | null
} {
  const result = buildNarrativeMemorySections(workId, chapterId)
  let hasPreviousChapter = false
  let previousChapterTitle: string | null = null
  let previousChapterContent = ''

  if (chapterId) {
    const continuity = getPreviousChapterContext(workId, chapterId)
    hasPreviousChapter = continuity.hasPrevious
    previousChapterTitle = continuity.previousChapterTitle
    previousChapterContent = continuity.fullContent
  }

  const activeCount = anchorDAO.listActiveByWork(workId).length
  const anchorLimitWarning = activeCount > MAX_ACTIVE_ANCHORS
    ? `活跃锚点 ${activeCount} 个，超出注入上限 ${MAX_ACTIVE_ANCHORS}，正文生成时仅注入前 ${MAX_ACTIVE_ANCHORS} 个`
    : null

  return {
    ...result,
    hasPreviousChapter,
    previousChapterTitle,
    previousChapterContent,
    previousChapterCharCount: previousChapterContent.replace(/\s/g, '').length,
    anchorLimitWarning
  }
}
