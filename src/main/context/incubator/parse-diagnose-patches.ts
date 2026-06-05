import { extractJsonText } from '../parse-json-extract'
import { isIncubatorSlotKey, type IncubatorSlotKey } from '../../../shared/incubator-slots'

export interface IncubatorDiagnosePatch {
  slotKey: IncubatorSlotKey
  text: string
}

export function parseDiagnosePatches(content: string): IncubatorDiagnosePatch[] {
  const jsonText = extractJsonText(content.trim())
  if (!jsonText) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }

  const raw = (parsed as { patches?: unknown }).patches
  if (!Array.isArray(raw)) return []

  const out: IncubatorDiagnosePatch[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const slotKey = String(row.slotKey ?? '').trim()
    const text = String(row.text ?? '').trim()
    if (!isIncubatorSlotKey(slotKey) || !text) continue
    out.push({ slotKey, text })
  }
  return out
}
