/** 小说 vs 短故事 —— 用户可见术语统一（拍/节拍 vs 章/章节，无分卷） */

export type WorkTypeKind = 'novel' | 'story'

export function isStoryWorkType(workType?: string | null): boolean {
  return workType === 'story'
}

export interface WorkUnitLabels {
  /** 计数单位：拍 / 章 */
  short: string
  /** 完整单位：节拍 / 章节 */
  full: string
  perUnit: string
  perUnitWords: string
  outline: string
  outlineStep: string
  planTitle: string
  plannedVerb: string
  planVerb: string
  listTitle: string
  sidebarListTitle: string
  wholeBodyTitle: string
  selectHint: string
  exportWhole: string
  exportSingleUnit: string
}

const NOVEL_LABELS: WorkUnitLabels = {
  short: '章',
  full: '章节',
  perUnit: '每章',
  perUnitWords: '每章字数',
  outline: '章节大纲',
  outlineStep: '章节情节',
  planTitle: '章节规划',
  plannedVerb: '已规划',
  planVerb: '规划',
  listTitle: '章节列表',
  sidebarListTitle: '章节',
  wholeBodyTitle: '',
  selectHint: '请从左侧选择章节',
  exportWhole: '全书',
  exportSingleUnit: '单章'
}

const STORY_LABELS: WorkUnitLabels = {
  short: '拍',
  full: '节拍',
  perUnit: '每拍',
  perUnitWords: '每拍字数',
  outline: '节拍大纲',
  outlineStep: '节拍大纲',
  planTitle: '节拍规划',
  plannedVerb: '已拆解',
  planVerb: '拆解',
  listTitle: '节拍列表',
  sidebarListTitle: '创作节拍',
  wholeBodyTitle: '整篇正文',
  selectHint: '请从左侧选择节拍',
  exportWhole: '全篇',
  exportSingleUnit: '单节拍'
}

export function workUnitLabels(workType?: string | null): WorkUnitLabels {
  return isStoryWorkType(workType) ? STORY_LABELS : NOVEL_LABELS
}

export function volumePlanCountLabel(count: number, suggested: number, workType?: string | null): string {
  const { short } = workUnitLabels(workType)
  if (suggested <= 0) return `${count} ${short}`
  return `${count}/${suggested} ${short}`
}

export interface BodyPromptParts {
  volName?: string | null
  volDescription?: string | null
  chapterTitle: string
  outline?: string | null
  wordTargetLine: string
}

/** 正文生成 user prompt 中的分卷/章节字段（短故事不出现「分卷」「章节」） */
export function formatBodyPromptLines(workType: string | null | undefined, parts: BodyPromptParts): string[] {
  const outline = parts.outline?.trim()
  if (isStoryWorkType(workType)) {
    return [
      parts.volDescription?.trim() ? `主线说明：${parts.volDescription.trim()}` : '',
      `节拍：${parts.chapterTitle}`,
      parts.wordTargetLine,
      outline
        ? `节拍大纲（本拍内容指引，非叙事起点；须先衔接上一拍结尾再自然展开）：\n${outline}`
        : '（暂无节拍大纲，请尽量根据作品上下文创作）'
    ].filter(Boolean)
  }
  return [
    `分卷：${parts.volName || ''}`,
    parts.volDescription?.trim() ? `分卷说明：${parts.volDescription.trim()}` : '',
    `章节：${parts.chapterTitle}`,
    parts.wordTargetLine,
    outline
      ? `章节大纲（本章内容指引，非叙事起点；须先衔接上一章结尾再自然展开）：\n${outline}`
      : '（暂无章节大纲，请尽量根据作品上下文创作）'
  ].filter(Boolean)
}

/** 合并导出正文时的节标题前缀 */
export function formatMergedBodySectionTitle(
  workType: string | null | undefined,
  index: number,
  title: string
): string {
  const t = title.trim()
  if (isStoryWorkType(workType)) {
    return t || `第${index + 1}拍`
  }
  return [`第${index + 1}章`, t].filter(Boolean).join(' ')
}
