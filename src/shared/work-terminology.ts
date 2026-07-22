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
  outlineStep: '章节大纲',
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
        ? [
          '节拍执行蓝图（硬约束，非叙事起点；须先衔接上一拍结尾再自然展开）：',
          '执行规则：',
          '1. 若蓝图包含【开场状态】，正文开头必须从该状态之后继续，不得复述上一拍已发生内容。',
          '2. 若蓝图包含【必须覆盖】，正文必须逐项落地，不得遗漏、合并成一句带过或改成无关事件。',
          '3. 若蓝图包含【禁止越界】，正文不得提前写这些后续内容，不得新增会改变后续规划的支线。',
          '4. 若蓝图包含【结尾落点】或【章末钩子】，正文结尾必须停在该落点附近，保持未完成态。',
          '5. 若蓝图包含【能力/状态约束】，正文中的消耗、恢复、伤势、资源变化必须与其一致。',
          '6. 禁止新增蓝图未指定的重要角色、势力、道具、能力、地点和支线；只能补足动作、对白、心理和场景执行细节。',
          outline
        ].join('\n')
        : '（暂无节拍大纲，请尽量根据作品上下文创作）'
    ].filter(Boolean)
  }
  return [
    `分卷：${parts.volName || ''}`,
    parts.volDescription?.trim() ? `分卷说明：${parts.volDescription.trim()}` : '',
    `章节：${parts.chapterTitle}`,
    parts.wordTargetLine,
    outline
      ? [
        '章节执行蓝图（硬约束，非叙事起点；须先衔接上一章结尾再自然展开）：',
        '执行规则：',
        '1. 若蓝图包含【开场状态】，正文开头必须从该状态之后继续，不得复述上一章已发生内容。',
        '2. 若蓝图包含【必须覆盖】，正文必须逐项落地，不得遗漏、合并成一句带过或改成无关事件。',
        '3. 若蓝图包含【禁止越界】，正文不得提前写这些后续内容，不得新增会改变后续规划的支线。',
        '4. 若蓝图包含【结尾落点】或【章末钩子】，正文结尾必须停在该落点附近，保持未完成态。',
        '5. 若蓝图包含【能力/状态约束】，正文中的消耗、恢复、伤势、资源变化必须与其一致。',
        '6. 禁止新增蓝图未指定的重要角色、势力、道具、能力、地点和支线；只能补足动作、对白、心理和场景执行细节。',
        outline
      ].join('\n')
      : '（暂无章节大纲，请尽量根据作品上下文创作）'
  ].filter(Boolean)
}

/** 合并导出正文时的节标题前缀 */
export function formatMergedBodySectionTitle(
  workType: string | null | undefined,
  index: number,
  title: string
): string {
  if (isStoryWorkType(workType)) {
    return String(index + 1)
  }
  return [`第${index + 1}章`, title.trim()].filter(Boolean).join(' ')
}

/**
 * 合并短故事全文：导语 + 编号节拍正文，格式对齐 docs/book/short.txt。
 * - 导语（hook）独占开头，交待核心故事、留住读者
 * - 各节拍以 1、2、3… 编号分隔，不展示节拍名
 *
 * @param hook 导语正文（work.description）
 * @param beatContents 各节拍正文数组（已按顺序排列，空内容自动跳过）
 */
export function buildMergedStoryText(hook: string, beatContents: string[]): string {
  const parts: string[] = []
  const hookText = hook?.trim()
  if (hookText) parts.push(hookText)
  let beatIndex = 0
  for (const content of beatContents) {
    const text = content?.trim()
    if (!text) continue
    parts.push(String(beatIndex + 1))
    parts.push(text)
    beatIndex++
  }
  return parts.join('\n\n')
}

/**
 * 短故事合并格式：导语在前，节拍以 1/2/3 编号分隔，不显示节拍名。
 * 格式参考 docs/book/short.txt：
 *   {导语}
 *
 *   1
 *
 *   {节拍1正文}
 *
 *   2
 *
 *   {节拍2正文}
 */
export function buildStoryMergedText(
  hook: string | null | undefined,
  beats: { content: string }[]
): string {
  const parts: string[] = []
  const hookText = hook?.trim()
  if (hookText) parts.push(hookText)
  beats.forEach((beat, i) => {
    const content = beat.content?.trim()
    if (!content) return
    parts.push(String(i + 1))
    parts.push(content)
  })
  return parts.join('\n\n')
}
