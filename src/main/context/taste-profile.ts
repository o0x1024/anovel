import { tasteProfileDAO, type RejectPattern } from '../db'

const REJECT_LABELS: Record<string, string> = {
  off_anchor: '偏离锚点',
  wrong_style: '文风不对',
  slow_pace: '情节拖沓',
  logic_error: '逻辑不通',
  cliche: '太俗套',
  bad_dialogue: '对话不自然',
  no_surprise: '缺乏惊喜',
  other: '其他问题'
}

export function getWorkTasteProfile(workId: number) {
  return tasteProfileDAO.getByWork(workId) ?? tasteProfileDAO.getDefault()
}

export function formatTasteForPrompt(workId: number): string {
  const profile = getWorkTasteProfile(workId)
  if (!profile) return ''

  const sections: string[] = ['【创作者品味档案 - 生成时请规避以下偏好】']
  const rejects = parseJson<RejectPattern[]>(profile.reject_patterns, [])
  if (rejects.length > 0) {
    sections.push(
      '高频否决项（务必避免）：',
      ...rejects.slice(0, 8).map(r => `- ${r.label || REJECT_LABELS[r.reason] || r.reason}（${r.count}次）`)
    )
  }

  if (profile.pacing_preferences?.trim()) {
    sections.push(`节奏偏好：${profile.pacing_preferences}`)
  }
  if (profile.plot_preferences?.trim()) {
    sections.push(`情节偏好：${profile.plot_preferences}`)
  }
  if (profile.character_preferences?.trim()) {
    sections.push(`角色偏好：${profile.character_preferences}`)
  }

  return sections.length > 1 ? sections.join('\n') : ''
}

export function recordTasteReject(workId: number, reason: string): void {
  let profile = tasteProfileDAO.getByWork(workId)
  if (!profile) {
    const defaultProfile = tasteProfileDAO.getDefault()
    if (defaultProfile) {
      tasteProfileDAO.bindToWork(workId, defaultProfile.id)
      profile = defaultProfile
    } else {
      const id = tasteProfileDAO.create({ profile_name: '默认品味', is_default: true })
      tasteProfileDAO.bindToWork(workId, id)
      profile = tasteProfileDAO.getById(id)
    }
  }
  if (profile) {
    tasteProfileDAO.recordReject(profile.id, reason, REJECT_LABELS[reason] || reason)
  }
}

export function recordTasteChoice(workId: number, choiceType: string, detail: string): void {
  const profile = getWorkTasteProfile(workId)
  if (profile) tasteProfileDAO.recordChoice(profile.id, choiceType, detail)
}

export function exportTasteProfile(profileId: number): string {
  const profile = tasteProfileDAO.getById(profileId)
  if (!profile) return '{}'
  return JSON.stringify(profile, null, 2)
}

export function importTasteProfile(json: string, workId?: number): number {
  const data = JSON.parse(json) as {
    profile_name?: string
    style_preferences?: string
    character_preferences?: string
    plot_preferences?: string
    pacing_preferences?: string
    reject_patterns?: string
    choice_history_summary?: string
  }
  const id = tasteProfileDAO.create({
    profile_name: data.profile_name || '导入档案',
    style_preferences: data.style_preferences,
    character_preferences: data.character_preferences,
    plot_preferences: data.plot_preferences,
    pacing_preferences: data.pacing_preferences,
    reject_patterns: data.reject_patterns,
    choice_history_summary: data.choice_history_summary
  })
  if (workId) tasteProfileDAO.bindToWork(workId, id)
  return id
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw?.trim()) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
