import { isIncubatorSlotKey } from '../../../shared/incubator-slots'
import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import { incubatorDraftSlotDAO, incubatorStateDAO } from '../../db/dao/incubator'
import { applyStatePathAfterAdopt } from './state-machine'

export function updateDraftSlotContent(
  workId: number,
  slotKey: string,
  content: string
): void {
  if (!isIncubatorSlotKey(slotKey)) {
    throw new Error('无效的槽位')
  }
  const trimmed = content.trim()
  if (trimmed) {
    incubatorDraftSlotDAO.upsertActiveSlot({
      workId,
      slotKey: slotKey as IncubatorSlotKey,
      content: trimmed,
      sourceCandidateId: null
    })
  } else {
    incubatorDraftSlotDAO.clearActiveSlot(workId, slotKey as IncubatorSlotKey)
  }
  const stateRow = incubatorStateDAO.getByWork(workId)
  const fromState = (stateRow?.state ?? 'SeedReady') as import('../../../shared/incubator-types').IncubatorWorkflowState
  const filled = incubatorDraftSlotDAO.countFilledSlots(workId)
  incubatorStateDAO.setState(workId, applyStatePathAfterAdopt(fromState, filled))
}
