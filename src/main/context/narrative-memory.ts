import { foreshadowingDAO, characterSnapshotDAO, timelineDAO, volumeChapterDAO, anchorDAO } from '../db'
import { coreSettingDAO } from '../db'
import { formatCharacterCardsForChapter, resolveChapterCharacterNames } from './character-cards'
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
  const isBodyGenerationMemory = !includeChapterOutline
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
  let chapterText = ''
  let focusCharacterNames: string[] = []
  let currentChapterIndex = -1
  const allChaptersForWork = chapterId ? volumeChapterDAO.listChaptersByWork(workId) : []

  if (chapterId) {
    const ch = volumeChapterDAO.getChapter(chapterId)
    if (ch) {
      chapterText = [ch.title, ch.outline, ch.foreshadow_target, ch.next_hook, ch.characters]
        .filter(Boolean)
        .join('\n')
      focusCharacterNames = resolveChapterCharacterNames(workId, ch)
      currentChapterIndex = allChaptersForWork.findIndex(row => row.id === chapterId)
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
  const focusedPending = isBodyGenerationMemory
    ? pending.filter(f => {
        const desc = f.description?.trim() ?? ''
        const plantLocation = f.plant_location?.trim() ?? ''
        if (f.status === 'partial' || f.depth === 'deep') return true
        if (desc && chapterText.includes(desc.slice(0, Math.min(12, desc.length)))) return true
        if (plantLocation && chapterText.includes(plantLocation.slice(0, Math.min(8, plantLocation.length)))) return true
        if (f.plant_chapter_id && currentChapterIndex >= 0) {
          const plantedIndex = allChaptersForWork.findIndex(ch => ch.id === f.plant_chapter_id)
          const distance = currentChapterIndex - plantedIndex
          return plantedIndex >= 0 && distance >= 0 && distance <= 3
        }
        return false
      }).slice(0, 12)
    : pending
  if (focusedPending.length > 0) {
    const omitted = pending.length - focusedPending.length
    sections.foreshadowing = [
      isBodyGenerationMemory
        ? `【本章相关待回收伏笔 - 仅在大纲适配时推进或回收${omitted > 0 ? `；另有 ${omitted} 条未注入` : ''}】`
        : '【待回收伏笔 - 本章应适当推进或回收】',
      ...focusedPending.map((f, i) => {
        const depth = DEPTH_LABELS[f.depth || 'normal'] || '普通'
        const loc = f.plant_location ? `（埋设于：${f.plant_location}）` : ''
        return `${i + 1}. [${depth}] ${f.description}${loc}`
      })
    ].join('\n')
  }

  const allSnapshotNames = characterSnapshotDAO.listCharacterNames(workId)
  const allSnapshots = allSnapshotNames
    .map(name => characterSnapshotDAO.getLatest(workId, name))
    .filter((s): s is NonNullable<typeof s> => !!s)
  snapshotCharacterCount = allSnapshots.length
  const focusSet = new Set(focusCharacterNames)
  const snapshots = isBodyGenerationMemory && focusSet.size > 0
    ? allSnapshots.filter(s => focusSet.has(s.character_name))
    : isBodyGenerationMemory
      ? allSnapshots.slice(0, 6)
      : allSnapshots
  if (snapshots.length > 0) {
    const omitted = allSnapshots.length - snapshots.length
    sections.snapshots = [
      isBodyGenerationMemory
        ? `【本章相关角色状态快照 - 出场角色须与此一致${omitted > 0 ? `；另有 ${omitted} 名角色未注入` : ''}】`
        : '【角色当前状态快照 - 出场角色须与此一致】',
      ...snapshots.map(s => {
        const parts = [
          `角色：${s.character_name}`,
          s.location ? `位置：${s.location}` : '',
          s.mental_state ? `心理：${s.mental_state}` : '',
          s.known_info ? `已知信息：${s.known_info}` : '',
          s.relationship_changes ? `关系变化：${s.relationship_changes}` : '',
          s.ability_changes ? `能力/资源：${s.ability_changes}` : ''
        ].filter(Boolean)
        if (s.numeric_stats) {
          try {
            const stats = JSON.parse(s.numeric_stats) as { name: string; value: string; unit?: string }[]
            if (Array.isArray(stats) && stats.length > 0) {
              const statsText = stats.map(st => `${st.name}:${st.value}${st.unit || ''}`).join('、')
              parts.push(`数值状态：${statsText}`)
            }
          } catch { /* 忽略解析失败 */ }
        }
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
