import {
  INCUBATOR_GATE_FIX_SYSTEM,
  buildGateFixUserPrompt
} from '../../../shared/incubator-analysis-prompts'
import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import { getWorkSlotKeys } from './slot-helpers'
import type { IncubatorGateReport } from '../../../shared/incubator-types'
import { incubatorDraftSlotDAO, incubatorSeedDAO, incubatorStateDAO } from '../../db/dao/incubator'
import { modelService } from '../../model'
import type { ChatOptions } from '../../model'
import { withWorkModelOptions, type WorkModelOptions } from '../../../shared/work-model-options'
import { extractJsonText } from '../parse-json-extract'
import { loadCharacterCards } from '../character-cards'
import { nameEntryDAO } from '../../db'
import { updateDraftSlotContent } from './update-slot'
import { parseDiagnosePatches, type IncubatorDiagnosePatch } from './parse-diagnose-patches'

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
    const registryNames = nameEntryDAO.listByWork(workId, 'character', 'adopted')
    for (const r of registryNames) {
      const name = r.name?.trim()
      if (name) namesSet.add(name)
    }
  } catch { /* ignore */ }
  return [...namesSet]
}

export interface GateFixResult {
  applied: number
  slotKeys: IncubatorSlotKey[]
  logicRebuild?: string
  error?: string
}

export async function runGateFix(
  workId: number,
  gateReport: IncubatorGateReport,
  chatOptions?: Pick<ChatOptions, 'webContents' | 'sessionTitle'>,
  modelOpts?: WorkModelOptions
): Promise<GateFixResult> {
  const slots = incubatorDraftSlotDAO.listActiveByWork(workId)
  const slotMap: Partial<Record<IncubatorSlotKey, string>> = {}
  const slotKeyList = getWorkSlotKeys(workId)
  for (const key of slotKeyList) {
    const content = slots.find(s => s.slot_key === key)?.content?.trim() ?? ''
    if (content) slotMap[key as IncubatorSlotKey] = content
  }

  const seed = incubatorSeedDAO.getByWork(workId)?.content?.trim() ?? ''
  const characters = loadCharacterNames(workId)
  const prompt = buildGateFixUserPrompt(seed, slotMap, gateReport, characters)

  const res = await modelService.chat(withWorkModelOptions({
    prompt,
    systemPrompt: INCUBATOR_GATE_FIX_SYSTEM,
    workId,
    step: 'incubator_gate_fix',
    enrichWorkContext: false,
    enrichNarrativeMemory: false
  }, modelOpts), chatOptions)

  if (!res.success) {
    return { applied: 0, slotKeys: [], error: res.error || '模型调用失败' }
  }

  const patches = parseDiagnosePatches(res.content)

  let logicRebuild: string | undefined
  try {
    const jsonText = extractJsonText(res.content.trim())
    if (jsonText) {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>
      if (typeof parsed.logic_rebuild === 'string') {
        logicRebuild = parsed.logic_rebuild.trim() || undefined
      }
    }
  } catch { /* ignore */ }

  if (!patches.length) {
    return { applied: 0, slotKeys: [], logicRebuild, error: '未能从 AI 回复解析出可入槽的修复项' }
  }

  const slotKeys: IncubatorSlotKey[] = []
  for (const patch of patches) {
    updateDraftSlotContent(workId, patch.slotKey, patch.text)
    if (!slotKeys.includes(patch.slotKey)) slotKeys.push(patch.slotKey)
  }

  incubatorStateDAO.setLastGateReport(workId, null)

  return { applied: patches.length, slotKeys, logicRebuild }
}
