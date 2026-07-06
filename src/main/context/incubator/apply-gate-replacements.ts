import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import { isIncubatorSlotKey } from '../../../shared/incubator-slots'
import { incubatorDraftSlotDAO } from '../../db/dao/incubator'
import { updateDraftSlotContent } from './update-slot'
import { fuzzyFindSpan, stripWithPositions } from '../../../shared/fuzzy-match'

export interface GateReplacementInput {
  slotKey: IncubatorSlotKey
  replacements: { original: string; replacement: string }[]
}

// ---------- public API ----------

export function applyGateReplacements(
  workId: number,
  items: GateReplacementInput[]
): { applied: number; failed: number; slotKeys: IncubatorSlotKey[] } {
  const slotKeys: IncubatorSlotKey[] = []
  let applied = 0
  let failed = 0

  const activeSlots = incubatorDraftSlotDAO.listActiveByWork(workId)

  for (const item of items) {
    if (!isIncubatorSlotKey(item.slotKey) || !item.replacements?.length) continue

    const slotRow = activeSlots.find(s => s.slot_key === item.slotKey)
    let content = slotRow?.content ?? ''
    let strippedCache = stripWithPositions(content)

    let slotModified = false
    for (const { original, replacement } of item.replacements) {
      if (!original) {
        failed++
        continue
      }
      const span = fuzzyFindSpan(content, original, 0, strippedCache)
      if (span) {
        content = content.slice(0, span.start) + replacement + content.slice(span.end)
        strippedCache = stripWithPositions(content)
        applied++
        slotModified = true
      } else {
        failed++
      }
    }

    if (slotModified) {
      updateDraftSlotContent(workId, item.slotKey, content)
      if (!slotKeys.includes(item.slotKey)) slotKeys.push(item.slotKey)
    }
  }

  return { applied, failed, slotKeys }
}
