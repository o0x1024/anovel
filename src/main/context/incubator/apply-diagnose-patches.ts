import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import { updateDraftSlotContent } from './update-slot'
import type { IncubatorDiagnosePatch } from './parse-diagnose-patches'

export function applyDiagnosePatchesToSlots(
  workId: number,
  patches: IncubatorDiagnosePatch[]
): { applied: number; slotKeys: IncubatorSlotKey[] } {
  const slotKeys: IncubatorSlotKey[] = []

  for (const patch of patches) {
    updateDraftSlotContent(workId, patch.slotKey, patch.text)
    if (!slotKeys.includes(patch.slotKey)) slotKeys.push(patch.slotKey)
  }

  return { applied: patches.length, slotKeys }
}
