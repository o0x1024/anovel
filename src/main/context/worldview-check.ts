import { coreSettingDAO } from '../db'

export interface WorldviewViolation {
  rule: string
  detail: string
  severity: 'warning' | 'error'
}

/**
 * 轻量世界观一致性校验（关键词/规则模式）
 */
export function checkWorldviewConsistency(workId: number, content: string): WorldviewViolation[] {
  const violations: WorldviewViolation[] = []
  const worldview = coreSettingDAO.getByType(workId, 'worldview')?.content?.trim()
  if (!worldview || !content.trim()) return violations

  const rules = extractRules(worldview)
  const text = content.toLowerCase()

  for (const rule of rules) {
    const forbidden = rule.forbidden
    for (const word of forbidden) {
      if (text.includes(word.toLowerCase())) {
        violations.push({
          rule: rule.label,
          detail: `正文出现可能与世界观冲突的表述：「${word}」`,
          severity: 'warning'
        })
      }
    }
  }

  const modernPatterns = [/手机|微信|互联网|高铁|飞机|美元|欧元/g]
  const isModernWorld = /现代|都市|当代|202[0-9]|201[0-9]/.test(worldview)
  const isAncientWorld = /古代|仙侠|玄幻|武侠|修仙|明朝|宋朝|唐朝/.test(worldview)

  if (isAncientWorld && !isModernWorld) {
    for (const pat of modernPatterns) {
      const match = content.match(pat)
      if (match) {
        violations.push({
          rule: '时代一致性',
          detail: `古代/幻想世界观中出现现代元素：${match[0]}`,
          severity: 'warning'
        })
      }
    }
  }

  return violations
}

function extractRules(worldview: string): { label: string; forbidden: string[] }[] {
  const rules: { label: string; forbidden: string[] }[] = []
  const lines = worldview.split('\n').filter(l => l.trim())
  for (const line of lines) {
    if (/禁止|不可|不能|绝不/.test(line)) {
      const forbidden = line.match(/[「""]([^」""]+)[」""]/g)?.map(s => s.replace(/[「""」""]/g, '')) ?? []
      if (forbidden.length) {
        rules.push({ label: line.slice(0, 30), forbidden })
      }
    }
  }
  return rules
}
