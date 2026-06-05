import { coreSettingDAO } from '../../db'
import {
  incubatorDraftSlotDAO,
  incubatorStateDAO,
  incubatorVersionDAO,
  type IncubatorVersionRow
} from '../../db/dao/incubator'
import { INCUBATOR_SLOT_KEYS, INCUBATOR_SLOT_LABELS } from '../../../shared/incubator-slots'
import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import type {
  IncubatorGateReport,
  IncubatorStorylineVersion,
  IncubatorVersionCompareResult
} from '../../../shared/incubator-types'

export interface ParsedVersionSnapshot {
  slots: Record<string, string>
  gate?: IncubatorGateReport
  frozenAt?: string
  synthesizedSummary?: string | null
  qualitySnapshot?: string | null
}

export function mapVersionRow(row: IncubatorVersionRow): IncubatorStorylineVersion {
  return {
    id: row.id,
    workId: row.work_id,
    versionNo: row.version_no,
    label: row.label,
    snapshotJson: row.snapshot_json,
    baseVersionId: row.base_version_id,
    isFrozen: row.is_frozen === 1,
    createdAt: row.create_time
  }
}

export function parseVersionSnapshot(json: string): ParsedVersionSnapshot {
  const parsed = JSON.parse(json) as ParsedVersionSnapshot
  return {
    slots: parsed.slots ?? {},
    gate: parsed.gate,
    frozenAt: parsed.frozenAt,
    synthesizedSummary: parsed.synthesizedSummary ?? null,
    qualitySnapshot: parsed.qualitySnapshot ?? null
  }
}

function syncIdeaFromSlots(workId: number, slots: Record<string, string>, title: string): void {
  const summaryLines = INCUBATOR_SLOT_KEYS
    .filter((k: IncubatorSlotKey) => slots[k]?.trim())
    .map((k: IncubatorSlotKey) => `## ${INCUBATOR_SLOT_LABELS[k]}\n${slots[k].trim()}`)

  if (!summaryLines.length) return
  coreSettingDAO.upsert(workId, 'idea', [`# ${title}`, ...summaryLines].join('\n\n'))
}

function applySnapshotToDraft(workId: number, slots: Record<string, string>): void {
  for (const key of INCUBATOR_SLOT_KEYS) {
    const content = slots[key]?.trim() ?? ''
    if (content) {
      incubatorDraftSlotDAO.upsertActiveSlot({
        workId,
        slotKey: key,
        content,
        sourceCandidateId: null
      })
    }
  }
}

export function listIncubatorVersions(workId: number): IncubatorStorylineVersion[] {
  return incubatorVersionDAO.listByWork(workId).map(mapVersionRow)
}

export function getIncubatorVersionDetail(
  workId: number,
  versionId: number
): { version: IncubatorStorylineVersion; snapshot: ParsedVersionSnapshot } | null {
  const row = incubatorVersionDAO.getById(versionId)
  if (!row || row.work_id !== workId) return null
  return {
    version: mapVersionRow(row),
    snapshot: parseVersionSnapshot(row.snapshot_json)
  }
}

export function restoreIncubatorVersion(
  workId: number,
  versionId: number
): { success: boolean; error?: string } {
  const detail = getIncubatorVersionDetail(workId, versionId)
  if (!detail) return { success: false, error: '版本不存在' }

  applySnapshotToDraft(workId, detail.snapshot.slots)
  incubatorStateDAO.setLastAdopt(workId, null)
  incubatorStateDAO.setBranchBaseVersion(workId, null)

  if (detail.version.isFrozen) {
    if (detail.snapshot.gate) {
      incubatorStateDAO.setLastGateReport(workId, JSON.stringify(detail.snapshot.gate))
    }
    syncIdeaFromSlots(workId, detail.snapshot.slots, detail.version.label || `Storyline V${detail.version.versionNo}`)
    incubatorStateDAO.setState(workId, 'V1Frozen')
  } else {
    incubatorStateDAO.setState(workId, 'Composing')
  }

  return { success: true }
}

/** 将版本快照载入当前草案，进入可编辑分支（下次冻结会记录 base_version_id） */
export function branchFromIncubatorVersion(
  workId: number,
  versionId: number
): { success: boolean; error?: string } {
  const detail = getIncubatorVersionDetail(workId, versionId)
  if (!detail) return { success: false, error: '版本不存在' }

  applySnapshotToDraft(workId, detail.snapshot.slots)
  incubatorStateDAO.setLastAdopt(workId, null)
  incubatorStateDAO.setBranchBaseVersion(workId, versionId)

  incubatorStateDAO.setState(workId, 'Composing')

  return { success: true }
}

export function compareIncubatorVersions(
  workId: number,
  versionIdA: number,
  versionIdB: number
): IncubatorVersionCompareResult | null {
  const a = getIncubatorVersionDetail(workId, versionIdA)
  const b = getIncubatorVersionDetail(workId, versionIdB)
  if (!a || !b) return null

  const slotDiffs = INCUBATOR_SLOT_KEYS.map(key => {
    const textA = a.snapshot.slots[key]?.trim() ?? ''
    const textB = b.snapshot.slots[key]?.trim() ?? ''
    return {
      slotKey: key,
      label: INCUBATOR_SLOT_LABELS[key],
      textA,
      textB,
      changed: textA !== textB
    }
  })

  return {
    versionA: {
      id: a.version.id,
      label: a.version.label,
      versionNo: a.version.versionNo
    },
    versionB: {
      id: b.version.id,
      label: b.version.label,
      versionNo: b.version.versionNo
    },
    slotDiffs
  }
}

export function getBranchBaseVersionId(workId: number): number | null {
  return incubatorStateDAO.getBranchBaseVersion(workId)
}

/** 当前草案六槽是否与最新冻结快照不一致（含分支编辑） */
export function draftDiffersFromLatestFrozen(workId: number): boolean {
  if (incubatorStateDAO.getBranchBaseVersion(workId) != null) return true

  const frozen = incubatorVersionDAO.getLatestFrozen(workId)
  if (!frozen) return false

  let snapSlots: Record<string, string> = {}
  try {
    snapSlots = parseVersionSnapshot(frozen.snapshot_json).slots
  } catch {
    return true
  }

  const active = incubatorDraftSlotDAO.listActiveByWork(workId)
  for (const key of INCUBATOR_SLOT_KEYS) {
    const draft = active.find(s => s.slot_key === key)?.content?.trim() ?? ''
    const snap = snapSlots[key]?.trim() ?? ''
    if (draft !== snap) return true
  }
  return false
}

export function nextStorylineFreezeVersionNo(workId: number): number {
  const frozen = incubatorVersionDAO.getLatestFrozen(workId)
  return (frozen?.version_no ?? 0) + 1
}
