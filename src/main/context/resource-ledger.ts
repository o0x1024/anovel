import { coreSettingDAO, resourceLedgerDAO, characterSnapshotDAO, volumeChapterDAO, type ChapterResourceBudgetInput, type ResourceConstraintInput } from '../db'
import { modelService } from '../model'
import { extractJsonText } from './parse-json-extract'

export interface ResourceGateResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
}

function jsonArray(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const arr = value.map(v => String(v).trim()).filter(Boolean)
  return arr.length > 0 ? JSON.stringify(arr) : null
}

function readNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value).trim()
  const match = text.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const n = Number(match[0])
  return Number.isFinite(n) ? n : null
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const jsonText = extractJsonText(content) ?? extractFirstObject(content)
  if (!jsonText) return null
  try {
    const parsed = JSON.parse(jsonText) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function extractFirstObject(content: string): string | null {
  const start = content.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < content.length; i++) {
    const ch = content[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return content.slice(start, i + 1)
    }
  }
  return null
}

function normalizeConstraint(item: unknown): ResourceConstraintInput | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const resource = String(row.resource ?? row.name ?? '').trim()
  if (!resource) return null
  return {
    owner: String(row.owner ?? '').trim() || null,
    resource,
    unit: String(row.unit ?? '').trim() || null,
    initial_value: readNumber(row.initial ?? row.initial_value),
    min_value: readNumber(row.min ?? row.min_value),
    max_value: readNumber(row.max ?? row.max_value),
    hard_rules_json: jsonArray(row.hardRules ?? row.hard_rules),
    milestones_json: Array.isArray(row.milestones) ? JSON.stringify(row.milestones) : null,
    spend_rules_json: jsonArray(row.spendRules ?? row.spend_rules),
    recover_rules_json: jsonArray(row.recoverRules ?? row.recover_rules),
    source_types: Array.isArray(row.sourceTypes ?? row.source_types)
      ? ((row.sourceTypes ?? row.source_types) as unknown[]).map(String).join(',')
      : String(row.sourceTypes ?? row.source_types ?? '').trim() || null
  }
}

export async function refreshResourceConstraints(workId: number, signal?: AbortSignal): Promise<number> {
  const settings = coreSettingDAO.listByWork(workId)
    .filter(s => ['protagonist', 'golden_finger', 'world_pressure', 'conflict_engine', 'pleasure_engine', 'supporting_cast', 'main_plotline'].includes(s.type))
  if (settings.length === 0) {
    resourceLedgerDAO.replaceConstraints(workId, [])
    return 0
  }
  const settingsText = settings.map(s => s.content).join('\n')

  const res = await modelService.chat(
    {
      workId,
      step: 'resource_constraints_extract',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      systemPrompt: [
        '你是小说资源状态规则抽取器。请从核心设定中抽取所有需要跨章节跟踪的可变数值状态。',
        '只输出合法 JSON，不要 markdown，不要解释。',
        '默认不创建数值资源。只有精确数值本身构成作品玩法或硬承诺时才抽取。',
        '禁止抽取：成功率、概率、修为境界、能力阶段、容量上限、冷却时长、身份暴露程度、关系状态、叙事倒计时、泛化灵力或寿命压力。它们应使用阶段、条件和事件状态跟踪。',
        '每项资源必须同时具备：原文直接证据、明确单位、初始值、可计算的增减规则，以及恢复/重置规则或不可恢复声明。缺一项就不得抽取。',
        '寿命、生命、命运等叙事概念，只有设定明确给出当前数值、单位、可计算增减规则或期限时才抽取；“寿命有限”“损耗寿命”等泛化描述不得抽取。',
        'evidence 必须逐字引用核心设定中同时包含资源名和量化规则的短句，禁止概括或补写。',
        '格式：{"resources":[{"owner":"主角","resource":"系统积分","unit":"点","initial":100,"min":0,"max":1000,"hardRules":[],"milestones":[],"spendRules":["兑换物品扣除对应积分"],"recoverRules":["完成任务获得明确积分"],"sourceTypes":["golden_finger"],"evidence":"原文逐字证据"}]}',
        '如果没有需要跟踪的资源，输出 {"resources":[]}'
      ].join('\n'),
      prompt: [
        '【核心设定】',
        ...settings.map(s => `## ${s.type}\n${s.content}`)
      ].join('\n\n')
    },
    { stream: false, signal }
  )

  if (!res.success || !res.content?.trim()) {
    throw new Error(res.error || '资源约束抽取失败')
  }
  const parsed = parseJsonObject(res.content.trim())
  const resources = Array.isArray(parsed?.resources) ? parsed.resources : null
  if (!resources) throw new Error('资源约束抽取结果解析失败')
  const constraints = resources
    .filter(item => {
      if (!item || typeof item !== 'object') return false
      const row = item as Record<string, unknown>
      const evidence = String(row.evidence ?? '').trim()
      const resource = String(row.resource ?? row.name ?? '').trim()
      if (!evidence || !settingsText.includes(evidence)) return false
      if (/成功率|概率|冷却|境界|修为|阶段|适配人数|容量|暴露程度|寿命/.test(resource)) return false
      const hasUnit = String(row.unit ?? '').trim().length > 0
      const hasInitial = readNumber(row.initial ?? row.initial_value) != null
      const spendRules = row.spendRules ?? row.spend_rules
      const recoverRules = row.recoverRules ?? row.recover_rules
      const hasSpend = Array.isArray(spendRules) && spendRules.length > 0
      const hasRecovery = Array.isArray(recoverRules) && recoverRules.length > 0
      return hasUnit && hasInitial && hasSpend && hasRecovery
    })
    .map(normalizeConstraint)
    .filter((x): x is ResourceConstraintInput => x != null)
  return resourceLedgerDAO.replaceConstraints(workId, constraints)
}

function readJsonArrayText(text?: string | null): string[] {
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

export function formatResourceConstraintsForPrompt(workId: number): string {
  const rows = resourceLedgerDAO.listConstraints(workId)
  if (rows.length === 0) return ''
  return [
    '【全书资源约束账本 - 大纲和正文都不得违反】',
    ...rows.map(r => {
      const limits = [
        r.initial_value != null ? `初始=${r.initial_value}${r.unit || ''}` : '',
        r.min_value != null ? `下限=${r.min_value}${r.unit || ''}` : '',
        r.max_value != null ? `上限=${r.max_value}${r.unit || ''}` : ''
      ].filter(Boolean).join('；')
      const hard = readJsonArrayText(r.hard_rules_json)
      const spend = readJsonArrayText(r.spend_rules_json)
      const recover = readJsonArrayText(r.recover_rules_json)
      return [
        `- ${r.owner || '未指定'} / ${r.resource}${r.unit ? `（${r.unit}）` : ''}${limits ? `：${limits}` : ''}`,
        hard.length ? `  硬规则：${hard.join('；')}` : '',
        r.milestones_json ? `  里程碑：${r.milestones_json}` : '',
        spend.length ? `  消耗：${spend.join('；')}` : '',
        recover.length ? `  恢复：${recover.join('；')}` : ''
      ].filter(Boolean).join('\n')
    })
  ].join('\n')
}

function normalizeBudget(item: unknown): ChapterResourceBudgetInput | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const resource = String(row.resource ?? row.name ?? '').trim()
  if (!resource) return null
  return {
    owner: String(row.owner ?? '').trim() || null,
    resource,
    unit: String(row.unit ?? '').trim() || null,
    start_min: readNumber(row.start_min ?? row.startMin),
    start_max: readNumber(row.start_max ?? row.startMax),
    end_min: readNumber(row.end_min ?? row.endMin),
    end_max: readNumber(row.end_max ?? row.endMax),
    allowed_events: Array.isArray(row.allowed_events ?? row.allowedEvents)
      ? ((row.allowed_events ?? row.allowedEvents) as unknown[]).map(String).filter(Boolean).join('；')
      : String(row.allowed_events ?? row.allowedEvents ?? '').trim() || null,
    forbidden_events: Array.isArray(row.forbidden_events ?? row.forbiddenEvents)
      ? ((row.forbidden_events ?? row.forbiddenEvents) as unknown[]).map(String).filter(Boolean).join('；')
      : String(row.forbidden_events ?? row.forbiddenEvents ?? '').trim() || null,
    reason: String(row.reason ?? '').trim() || null
  }
}

export function normalizeChapterResourceBudgets(value: unknown): ChapterResourceBudgetInput[] {
  if (!value) return []
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).map(([resource, budget]) => ({ ...(budget as Record<string, unknown>), resource }))
      : []
  return raw.map(normalizeBudget).filter((x): x is ChapterResourceBudgetInput => x != null)
}

export function formatChapterResourceBudgetsForPrompt(workId: number, chapterId: number): string {
  const budgets = resourceLedgerDAO.listBudgetsByChapter(workId, chapterId)
  if (budgets.length === 0) return ''
  return [
    '【本章资源预算 - 正文必须执行】',
    ...budgets.map(b => [
      `- ${b.owner || '未指定'} / ${b.resource}${b.unit ? `（${b.unit}）` : ''}`,
      `  开章允许：${b.start_min ?? '?'}-${b.start_max ?? '?'}${b.unit || ''}；章末必须：${b.end_min ?? '?'}-${b.end_max ?? '?'}${b.unit || ''}`,
      b.allowed_events ? `  允许事件：${b.allowed_events}` : '',
      b.forbidden_events ? `  禁止事件：${b.forbidden_events}` : '',
      b.reason ? `  预算理由：${b.reason}` : ''
    ].filter(Boolean).join('\n'))
  ].join('\n')
}

function parseNumericStats(text: string | null): { name: string; value: number; unit?: string }[] {
  if (!text) return []
  try {
    const arr = JSON.parse(text) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .map((item): { name: string; value: number; unit?: string } | null => {
        if (!item || typeof item !== 'object') return null
        const row = item as Record<string, unknown>
        const name = String(row.name ?? '').trim()
        const value = readNumber(row.value)
        if (!name || value == null) return null
        const unit = String(row.unit ?? '').trim()
        return { name, value, ...(unit ? { unit } : {}) }
      })
      .filter((x): x is { name: string; value: number; unit?: string } => x != null)
  } catch {
    return []
  }
}

function resourceMatches(a: string, b: string): boolean {
  return a === b || a.includes(b) || b.includes(a)
}

export function runResourceConstraintGate(workId: number, chapterId: number): ResourceGateResult {
  const budgets = resourceLedgerDAO.listBudgetsByChapter(workId, chapterId)
  if (budgets.length === 0) return { passed: true, blockers: [], warnings: [] }
  const blockers: string[] = []
  const warnings: string[] = []
  const snapshots = characterSnapshotDAO.listByWork(workId)
    .filter(s => s.chapter_id === chapterId)
    .sort((a, b) => b.chapter_id - a.chapter_id || b.id - a.id)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const chapterOrdinal = chapters.findIndex(chapter => chapter.id === chapterId) + 1
  const constraints = resourceLedgerDAO.listConstraints(workId)

  for (const budget of budgets) {
    const matched = snapshots.find(s => {
      if (budget.owner && s.character_name && !s.character_name.includes(budget.owner) && !budget.owner.includes(s.character_name)) return false
      return parseNumericStats(s.numeric_stats).some(st => resourceMatches(st.name, budget.resource))
    })
    if (!matched) {
      const unchangedAllowed = budget.start_min != null
        && budget.start_max != null
        && budget.end_min != null
        && budget.end_max != null
        && Math.max(budget.start_min, budget.end_min) <= Math.min(budget.start_max, budget.end_max)
      if (unchangedAllowed) {
        warnings.push(`${budget.resource}：本章未提取到章末快照，预算允许保持不变，按开章状态继承`)
      } else {
        blockers.push(
          `${budget.resource}：预算要求从 ${budget.start_min}-${budget.start_max}${budget.unit || ''} `
          + `变化到 ${budget.end_min}-${budget.end_max}${budget.unit || ''}，但本章未提取到章末数值快照`
        )
      }
      continue
    }
    const stat = parseNumericStats(matched.numeric_stats).find(st => resourceMatches(st.name, budget.resource))
    if (!stat) continue
    if (budget.end_min != null && stat.value < budget.end_min) {
      blockers.push(`${budget.resource}=${stat.value}${stat.unit || budget.unit || ''} 低于本章预算下限 ${budget.end_min}${budget.unit || ''}`)
    }
    if (budget.end_max != null && stat.value > budget.end_max) {
      blockers.push(`${budget.resource}=${stat.value}${stat.unit || budget.unit || ''} 高于本章预算上限 ${budget.end_max}${budget.unit || ''}`)
    }
    const constraint = constraints.find(row => resourceMatches(row.resource, budget.resource)
      && (!budget.owner || !row.owner || row.owner.includes(budget.owner) || budget.owner.includes(row.owner)))
    if (constraint?.min_value != null && stat.value < constraint.min_value) {
      blockers.push(`${budget.resource}=${stat.value} 低于全书硬下限 ${constraint.min_value}`)
    }
    if (constraint?.max_value != null && stat.value > constraint.max_value) {
      blockers.push(`${budget.resource}=${stat.value} 高于全书硬上限 ${constraint.max_value}`)
    }
    if (constraint?.milestones_json && chapterOrdinal > 0) {
      try {
        const milestones = JSON.parse(constraint.milestones_json) as Array<Record<string, unknown>>
        for (const milestone of milestones.filter(item => Number(item.chapter) === chapterOrdinal)) {
          const min = readNumber(milestone.min)
          const max = readNumber(milestone.max)
          if (min != null && stat.value < min) blockers.push(`${budget.resource} 未达到第 ${chapterOrdinal} 章里程碑下限 ${min}`)
          if (max != null && stat.value > max) blockers.push(`${budget.resource} 超过第 ${chapterOrdinal} 章里程碑上限 ${max}`)
        }
      } catch {
        blockers.push(`${budget.resource} 的里程碑配置不是合法 JSON`)
      }
    }
  }

  return { passed: blockers.length === 0, blockers, warnings }
}
