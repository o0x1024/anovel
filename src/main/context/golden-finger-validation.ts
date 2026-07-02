import { coreSettingDAO } from '../db'
import {
  parseGoldenFingerFromMarkdown,
  normalizeGoldenFinger,
  goldenFingerValidationIssues,
  formatGoldenFingerConstraints,
  type GoldenFingerStructured
} from '../../shared/golden-finger-types'

export { formatGoldenFingerConstraints }

export interface GoldenFingerValidationResult {
  valid: boolean
  issues: string[]
  constraints: string
  structured: GoldenFingerStructured
}

export function loadGoldenFingerStructured(workId: number): GoldenFingerStructured {
  const row = coreSettingDAO.getByType(workId, 'golden_finger')
  if (row?.structured_content) {
    try {
      const parsed = JSON.parse(row.structured_content) as Partial<GoldenFingerStructured>
      return normalizeGoldenFinger(parsed)
    } catch {
      // fall through to markdown parse
    }
  }
  return parseGoldenFingerFromMarkdown(row?.content ?? '')
}

export function validateGoldenFinger(workId: number): GoldenFingerValidationResult {
  const structured = loadGoldenFingerStructured(workId)
  const issues = goldenFingerValidationIssues(structured)
  return {
    valid: issues.length === 0,
    issues,
    constraints: formatGoldenFingerConstraints(structured),
    structured
  }
}

export function goldenFingerCrossSettingIssues(workId: number, gf: GoldenFingerStructured): string[] {
  const issues: string[] = []
  const protagonist = coreSettingDAO.getByType(workId, 'protagonist')?.content?.trim() ?? ''
  const worldPressure = coreSettingDAO.getByType(workId, 'world_pressure')?.content?.trim() ?? ''
  const conflictEngine = coreSettingDAO.getByType(workId, 'conflict_engine')?.content?.trim() ?? ''
  const pleasureEngine = coreSettingDAO.getByType(workId, 'pleasure_engine')?.content?.trim() ?? ''

  if (protagonist && gf.nameAndForm) {
    const hasProtagonistTag = protagonist.includes(gf.nameAndForm.slice(0, 12))
    if (!hasProtagonistTag && gf.nameAndForm.length > 4) {
      issues.push('金手指名称未在主角设计中出现，建议检查是否与主角标签绑定')
    }
  }

  if (worldPressure && gf.visualMetric.currentLevel) {
    const worldText = worldPressure.toLowerCase()
    const invalidKeywords = ['无敌', '全能', '没有限制', '任意使用']
    for (const kw of invalidKeywords) {
      if (gf.nameAndForm.includes(kw) || gf.infoAdvantage.includes(kw)) {
        issues.push(`金手指出现「${kw}」类描述，违反番茄网文「限制即张力」原则`)
      }
    }
    if (gf.limit.cooldown?.includes('无') && gf.limit.cost?.includes('无') && gf.limit.usageLimit?.includes('无')) {
      issues.push('金手指限制全部为空，正文极易写成无敌流')
    }
  }

  if (conflictEngine && gf.backlash) {
    const conflictText = conflictEngine.toLowerCase()
    if (!conflictText.includes('金手指') && !conflictText.includes(gf.nameAndForm.slice(0, 6))) {
      issues.push('冲突升级引擎未提及金手指或其代价，建议把反噬机制纳入冲突')
    }
  }

  if (pleasureEngine && gf.firstPayoffScene) {
    if (!pleasureEngine.includes('金手指') && !pleasureEngine.includes(gf.nameAndForm.slice(0, 6))) {
      issues.push('爽点机制未呼应金手指，前三章爽点场景可能无法落地')
    }
  }

  if (gf.visibility.trim()) {
    const visibleKeywords = ['可见', '光芒', '声音', '气息', '波动', '身体变化', '异象', '发光']
    const hasExternalEffect = visibleKeywords.some(kw => gf.visibility.includes(kw))
    if (hasExternalEffect && !gf.exposureConsequence.trim()) {
      issues.push('金手指使用时有外在表现（外人可见性中提到），但未设定暴露后果，建议补充被发现后的风险与冲突')
    }
  }

  if (gf.visibility.trim() && conflictEngine) {
    const hasVisibleEffect = ['可见', '光芒', '声音', '气息', '波动', '异象'].some(kw => gf.visibility.includes(kw))
    const conflictMentionsExposure = conflictEngine.includes('暴露') || conflictEngine.includes('隐藏') ||
      conflictEngine.includes('发现') || conflictEngine.includes('身份')
    if (hasVisibleEffect && !conflictMentionsExposure) {
      issues.push('金手指有外在可见表现，但冲突升级引擎未涉及暴露/隐藏/身份发现等冲突线，建议将外显性纳入冲突设计')
    }
  }

  if (gf.sourceNature.trim() && worldPressure) {
    const sourceMentionsSystem = gf.sourceNature.includes('系统') || gf.sourceNature.includes('面板')
    const worldMentionsSystem = worldPressure.includes('系统') || worldPressure.includes('面板')
    if (sourceMentionsSystem && !worldMentionsSystem) {
      issues.push('金手指来源涉及「系统」，但世界观压力规则中未提及系统类设定，建议补充系统在世界观中的存在依据')
    }
  }

  return issues
}
