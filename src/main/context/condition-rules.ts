import { coreSettingDAO } from '../db'

const CONDITION_RULES_TYPE = 'condition_rules'

export function getConditionRules(workId: number): string[] {
  const row = coreSettingDAO.getByType(workId, CONDITION_RULES_TYPE)
  if (!row?.content?.trim()) return []
  try {
    const parsed = JSON.parse(row.content) as unknown
    return Array.isArray(parsed) ? parsed.filter(r => typeof r === 'string' && r.trim()) : []
  } catch {
    return row.content.split('\n').map(s => s.trim()).filter(Boolean)
  }
}

export function setConditionRules(workId: number, rules: string[]): void {
  coreSettingDAO.upsert(workId, CONDITION_RULES_TYPE, JSON.stringify(rules.filter(r => r.trim())))
}

export function formatConditionRulesForPrompt(workId: number): string {
  const rules = getConditionRules(workId)
  if (rules.length === 0) return ''
  return [
    '【全局创作规则 - 必须严格遵守】',
    ...rules.map((r, i) => `${i + 1}. ${r}`)
  ].join('\n')
}
