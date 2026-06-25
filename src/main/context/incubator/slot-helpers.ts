import { workDAO } from '../../db'
import { getSlotKeysForWorkType, getIncubatorSlotLabel, type IncubatorSlotKey } from '../../../shared/incubator-slots'

export function getWorkType(workId: number): string | null {
  return workDAO.getById(workId)?.work_type ?? null
}

export function getWorkSlotKeys(workId: number): readonly IncubatorSlotKey[] {
  return getSlotKeysForWorkType(getWorkType(workId))
}

export function getWorkSlotLabel(workId: number, key: IncubatorSlotKey): string {
  return getIncubatorSlotLabel(key, getWorkType(workId))
}
