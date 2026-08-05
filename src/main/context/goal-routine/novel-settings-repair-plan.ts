import type {
  ParsedReportSection,
  ReviseSettingType
} from '../settings-quality'

const CROSS_SETTING_TYPES: readonly ReviseSettingType[] = [
  'protagonist',
  'golden_finger',
  'world_pressure',
  'conflict_engine',
  'pleasure_engine',
  'supporting_cast'
]

export interface NovelSettingsRepairTask {
  settingType: ReviseSettingType
  reportSections: Array<{
    title: string
    content: string
  }>
  requiresCrossContext: boolean
}

/**
 * 把深度自检的 blocking 结论编译成落稿任务。
 * 同一设定只落稿一次，避免分别处理局部问题和跨设定问题时反复覆盖。
 */
export function buildNovelSettingsRepairTasks(
  sections: ParsedReportSection[]
): NovelSettingsRepairTask[] {
  const tasks = new Map<ReviseSettingType, NovelSettingsRepairTask>()

  const addTask = (
    settingType: ReviseSettingType,
    section: ParsedReportSection,
    requiresCrossContext: boolean
  ) => {
    const current = tasks.get(settingType) ?? {
      settingType,
      reportSections: [],
      requiresCrossContext: false
    }
    if (!current.reportSections.some(item => item.title === section.title)) {
      current.reportSections.push({ title: section.title, content: section.content })
    }
    current.requiresCrossContext ||= requiresCrossContext
    tasks.set(settingType, current)
  }

  for (const section of sections) {
    if (section.severity !== 'blocking') continue
    if (section.reviseType) {
      addTask(section.reviseType, section, false)
      continue
    }
    if (section.action === 'revise-cross') {
      for (const settingType of CROSS_SETTING_TYPES) {
        addTask(settingType, section, true)
      }
    }
  }

  return [...tasks.values()]
}

export function formatNovelSettingsRepairTask(task: NovelSettingsRepairTask): string {
  return task.reportSections
    .map(section => `## ${section.title}\n${section.content}`)
    .join('\n\n')
}
