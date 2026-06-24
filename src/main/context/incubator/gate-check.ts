import { INCUBATOR_GATE_CHECK_SYSTEM, buildGateCheckUserPrompt } from '../../../shared/incubator-analysis-prompts'
import { INCUBATOR_SLOT_KEYS, isIncubatorSlotKey } from '../../../shared/incubator-slots'
import type { IncubatorGateReport } from '../../../shared/incubator-types'
import { incubatorDraftSlotDAO, incubatorSeedDAO, incubatorStateDAO } from '../../db/dao/incubator'
import { modelService } from '../../model'
import type { ChatOptions } from '../../model'
import { withWorkModelOptions, type WorkModelOptions } from '../../../shared/work-model-options'
import { extractJsonText } from '../parse-json-extract'
import { loadCharacterCards } from '../character-cards'
import { nameEntryDAO } from '../../db'

function loadCharacterNames(workId: number): string[] {
  const namesSet = new Set<string>()
  try {
    const cards = loadCharacterCards(workId)
    for (const c of cards) {
      const name = c.name?.trim()
      if (name) namesSet.add(name)
    }
  } catch { /* ignore */ }
  try {
    const registryNames = nameEntryDAO.listByWork(workId, 'character')
    for (const r of registryNames) {
      const name = r.name?.trim()
      if (name) namesSet.add(name)
    }
  } catch { /* ignore */ }
  return [...namesSet]
}

function clampScore(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function toStringArray(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(v => {
      if (v == null) return ''
      if (typeof v === 'string') return v.trim()
      if (typeof v === 'object') {
        const obj = v as Record<string, unknown>
        const text = obj.issue ?? obj.text ?? obj.message ?? obj.description ?? obj.suggestion
        if (typeof text === 'string') return text.trim()
        return JSON.stringify(v)
      }
      return String(v).trim()
    })
    .filter(Boolean)
    .slice(0, max)
}

function parseReplacements(value: unknown): { original: string; replacement: string }[] {
  if (!Array.isArray(value)) return []
  const out: { original: string; replacement: string }[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const original = typeof r.original === 'string' ? r.original : ''
    const replacement = typeof r.replacement === 'string' ? r.replacement : ''
    if (!original.trim()) continue
    out.push({ original, replacement })
  }
  return out
}

function parseGateReportContent(content: string, filledSlotCount: number): IncubatorGateReport | null {
  const jsonText = extractJsonText(content.trim())
  if (!jsonText) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const row = parsed as Record<string, unknown>
  const issues = toStringArray(row.issues)
  const suggestions = toStringArray(row.suggestions)
  const rawCoherence = Array.isArray(row.coherence) ? row.coherence : []
  const coherence: IncubatorGateReport['coherence'] = rawCoherence
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const r = item as Record<string, unknown>
      const slotKey = String(r.slotKey ?? '').trim()
      const severity = String(r.severity ?? '').trim()
      const issue = String(r.issue ?? '').trim()
      const suggestion = String(r.suggestion ?? '').trim()
      if (!isIncubatorSlotKey(slotKey) || !issue || !suggestion) return null
      if (severity !== 'blocking' && severity !== 'warning') return null
      const replacements = parseReplacements(r.replacements)
      return { slotKey, severity, issue, suggestion, ...(replacements.length ? { replacements } : {}) }
    })
    .filter((x): x is IncubatorGateReport['coherence'][number] => x != null)

  const blockingCount = coherence.filter(c => c.severity === 'blocking').length
  const reportedPassed = typeof row.passed === 'boolean' ? row.passed : null
  const passed = reportedPassed ?? (blockingCount === 0)

  const rawGlobalAnalysis = row.global_analysis ?? row.globalAnalysis
  const globalAnalysis = typeof rawGlobalAnalysis === 'string' ? rawGlobalAnalysis.trim() : undefined

  return {
    passed,
    filledSlotCount,
    serializabilityScore: clampScore(row.serializabilityScore),
    conflictClosureScore: clampScore(row.conflictClosureScore),
    issues,
    suggestions,
    coherence,
    ...(globalAnalysis ? { globalAnalysis } : {})
  }
}

function fallbackGateReport(filledSlotCount: number, reason: string): IncubatorGateReport {
  return {
    passed: false,
    filledSlotCount,
    serializabilityScore: 0,
    conflictClosureScore: 0,
    issues: [
      '门禁模型调用异常，无法完成自动判定',
      '需对六槽进行独立结构审查',
      ...(filledSlotCount < 6 ? [`仅 ${filledSlotCount}/6 槽已填写，缺少内容`] : [])
    ],
    suggestions: [
      reason || '请稍后重试门禁，或检查模型配置后再试',
      '请逐一审查六槽内容，重点检查：主冲突是否清晰且可持续推进、角色驱动是否真正支撑主冲突而非平行叙述、世界规则是否构成压力系统并能持续逼迫角色选择、六槽之间是否因果闭环',
      '若发现薄弱或空置槽位，请基于创作种子补全或强化该槽位（400-800字，必须极其饱满完善，细节丰富）'
    ],
    coherence: []
  }
}

export async function runIncubatorGate(
  workId: number,
  userInstruction?: string,
  chatOptions?: Pick<ChatOptions, 'webContents' | 'sessionTitle'>,
  modelOpts?: WorkModelOptions
): Promise<IncubatorGateReport> {
  const slots = incubatorDraftSlotDAO.listActiveByWork(workId)
  const slotMap: Record<string, string> = {}
  for (const key of INCUBATOR_SLOT_KEYS) {
    slotMap[key] = slots.find(s => s.slot_key === key)?.content?.trim() ?? ''
  }

  const seed = incubatorSeedDAO.getByWork(workId)?.content?.trim() ?? ''
  const characters = loadCharacterNames(workId)

  const filledSlotCount = slots.filter(s => s.content.trim()).length
  const prompt = buildGateCheckUserPrompt(slotMap, seed, characters, userInstruction)
  const res = await modelService.chat(withWorkModelOptions({
    prompt,
    systemPrompt: INCUBATOR_GATE_CHECK_SYSTEM,
    workId,
    step: 'incubator_gate_check',
    enrichWorkContext: false,
    enrichNarrativeMemory: false
  }, modelOpts), chatOptions)

  const report = res.success && res.content.trim()
    ? (parseGateReportContent(res.content, filledSlotCount) ??
      fallbackGateReport(filledSlotCount, 'AI 返回内容未通过门禁解析'))
    : fallbackGateReport(filledSlotCount, res.error || '模型调用失败')

  incubatorStateDAO.ensure(workId)
  incubatorStateDAO.setLastGateReport(workId, JSON.stringify(report))
  incubatorStateDAO.setState(workId, 'GateChecking')

  return report
}
