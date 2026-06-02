import type { StyleAnalysisResult } from './assistant-types'

export interface StyleAnalysisDiffItem {
  field: string
  label: string
  before: string
  after: string
  changed: boolean
}

export function compareStyleAnalyses(
  previous: StyleAnalysisResult,
  current: StyleAnalysisResult
): StyleAnalysisDiffItem[] {
  const items: StyleAnalysisDiffItem[] = []

  const add = (field: string, label: string, before: string, after: string) => {
    items.push({
      field,
      label,
      before,
      after,
      changed: before.trim() !== after.trim()
    })
  }

  add('styleName', '文风名称', previous.styleName, current.styleName)
  add('description', '描述', previous.description, current.description)
  add('sentenceRhythm', '句长节奏', previous.dimensions.sentenceRhythm, current.dimensions.sentenceRhythm)
  add('dialogueStyle', '对话风格', previous.dimensions.dialogueStyle, current.dimensions.dialogueStyle)
  add('narrativeDistance', '叙述距离', previous.dimensions.narrativeDistance, current.dimensions.narrativeDistance)
  add('pacing', '节奏', previous.dimensions.pacing, current.dimensions.pacing)
  add('vocabularyNotes', '词汇偏好', previous.dimensions.vocabularyNotes, current.dimensions.vocabularyNotes)
  add(
    'rhetoricPrefs',
    '修辞偏好',
    previous.dimensions.rhetoricPrefs.join('、'),
    current.dimensions.rhetoricPrefs.join('、')
  )
  add(
    'taboos',
    '禁忌表达',
    previous.dimensions.taboos.join('、'),
    current.dimensions.taboos.join('、')
  )
  add(
    'promptTemplate',
    'Prompt 模板',
    previous.promptTemplate.slice(0, 200) + (previous.promptTemplate.length > 200 ? '…' : ''),
    current.promptTemplate.slice(0, 200) + (current.promptTemplate.length > 200 ? '…' : '')
  )

  return items
}

export function hasStyleAnalysisChanges(items: StyleAnalysisDiffItem[]): boolean {
  return items.some(i => i.changed)
}
