import { coreSettingDAO } from '../../db'
import {
  incubatorCandidateDAO,
  incubatorDraftSlotDAO,
  incubatorScoreDAO,
  incubatorSeedDAO,
  incubatorStateDAO,
  incubatorVersionDAO,
  type IncubatorCandidateRow,
  type IncubatorDraftSlotRow
} from '../../db/dao/incubator'
import type {
  IncubatorCandidate,
  IncubatorCandidateScore,
  IncubatorDraftSlot,
  IncubatorGateReport,
  IncubatorLastAdoptAction,
  IncubatorSeed,
  IncubatorStorylineVersion,
  IncubatorWorkflowState,
  IncubatorWorkspaceState
} from '../../../shared/incubator-types'
import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import { backfillIncubatorFromLegacy } from './backfill-legacy'
import { pruneDuplicateCandidates } from './candidate-dedup'
import {
  draftDiffersFromLatestFrozen,
  listIncubatorVersions,
  nextStorylineFreezeVersionNo
} from './version-ops'
import { assertIncubatorWorkExists, sanitizeIncubatorFkOrphans } from './sanitize-incubator-fk'

function sanitizeStringArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return arr
    .map(v => {
      if (v == null) return ''
      if (typeof v === 'string') return v === '[object Object]' ? '' : v.trim()
      if (typeof v === 'object') {
        const obj = v as Record<string, unknown>
        const text = obj.issue ?? obj.text ?? obj.message ?? obj.description ?? obj.suggestion
        if (typeof text === 'string') return text.trim()
        return JSON.stringify(v)
      }
      return String(v).trim()
    })
    .filter(Boolean)
}

function mapCandidate(row: IncubatorCandidateRow): IncubatorCandidate {
  return {
    id: row.id,
    workId: row.work_id,
    sourceStep: row.source_step as IncubatorCandidate['sourceStep'],
    title: row.title,
    summary: row.summary,
    dimension: row.dimension,
    highlights: row.highlights,
    audience: row.audience,
    status: row.status as IncubatorCandidate['status'],
    createdAt: row.create_time
  }
}

function mapScore(row: import('../../db/dao/incubator/score-dao').IncubatorScoreRow): IncubatorCandidateScore {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    attractionScore: row.attraction_score,
    serializabilityScore: row.serializability_score,
    differentiationScore: row.differentiation_score,
    conflictClosureScore: row.conflict_closure_score,
    executabilityScore: row.executability_score,
    systemTotal: row.system_total,
    userAdjustment: row.user_adjustment,
    finalTotal: row.final_total,
    rationale: row.rationale,
    createdAt: row.create_time
  }
}

function mapSlot(row: IncubatorDraftSlotRow): IncubatorDraftSlot {
  return {
    id: row.id,
    workId: row.work_id,
    slotKey: row.slot_key as IncubatorSlotKey,
    content: row.content,
    sourceCandidateId: row.source_candidate_id,
    status: row.status as 'active' | 'deprecated',
    versionTag: row.version_tag,
    updateTime: row.update_time ?? null
  }
}

export function getIncubatorWorkspaceState(workId: number): IncubatorWorkspaceState {
  assertIncubatorWorkExists(workId)
  sanitizeIncubatorFkOrphans(workId)
  pruneDuplicateCandidates(workId)
  backfillIncubatorFromLegacy(workId)

  const stateRow = incubatorStateDAO.ensure(workId)
  const seedRow = incubatorSeedDAO.getByWork(workId)
  const ideaSetting = coreSettingDAO.getByType(workId, 'idea')

  let gateSummary: IncubatorGateReport | null = null
  if (stateRow.last_gate_report_json) {
    try {
      const parsed = JSON.parse(stateRow.last_gate_report_json) as Partial<IncubatorGateReport>
      gateSummary = {
        passed: !!parsed.passed,
        filledSlotCount: parsed.filledSlotCount ?? 0,
        serializabilityScore: parsed.serializabilityScore ?? 0,
        conflictClosureScore: parsed.conflictClosureScore ?? 0,
        issues: sanitizeStringArray(parsed.issues),
        suggestions: sanitizeStringArray(parsed.suggestions),
        coherence: parsed.coherence ?? []
      }
    } catch {
      gateSummary = null
    }
  }

  let lastAdopt: IncubatorLastAdoptAction | null = null
  if (stateRow.last_adopt_json) {
    try {
      lastAdopt = JSON.parse(stateRow.last_adopt_json) as IncubatorLastAdoptAction
    } catch {
      lastAdopt = null
    }
  }

  const candidates = incubatorCandidateDAO.listByWork(workId).map(row => {
    const latest = incubatorScoreDAO.getLatestByCandidate(row.id)
    return {
      ...mapCandidate(row),
      latestScore: latest ? mapScore(latest) : null
    }
  })

  const frozen = incubatorVersionDAO.getLatestFrozen(workId)
  const latestFrozenVersion: IncubatorStorylineVersion | null = frozen
    ? {
        id: frozen.id,
        workId: frozen.work_id,
        versionNo: frozen.version_no,
        label: frozen.label,
        snapshotJson: frozen.snapshot_json,
        baseVersionId: frozen.base_version_id,
        isFrozen: frozen.is_frozen === 1,
        createdAt: frozen.create_time
      }
    : null

  const seed: IncubatorSeed | null = seedRow
    ? {
        workId: seedRow.work_id,
        content: seedRow.content,
        updateTime: seedRow.update_time ?? null
      }
    : null

  return {
    state: stateRow.state as IncubatorWorkflowState,
    seed,
    activeDraftSlots: incubatorDraftSlotDAO.listActiveByWork(workId).map(mapSlot),
    candidates,
    versions: listIncubatorVersions(workId),
    latestFrozenVersion,
    draftDirtySinceFreeze: draftDiffersFromLatestFrozen(workId),
    nextFreezeVersionNo: nextStorylineFreezeVersionNo(workId),
    branchBaseVersionId: stateRow.branch_base_version_id ?? null,
    gateSummary,
    lastAdopt,
    ideaCompat: ideaSetting?.content?.trim() ?? seed?.content ?? ''
  }
}

export function setIncubatorSeed(workId: number, content: string): void {
  const trimmed = content.trim()
  incubatorSeedDAO.upsert(workId, trimmed)
  coreSettingDAO.upsert(workId, 'idea', trimmed)
  incubatorStateDAO.ensure(workId, 'SeedReady')
  if (trimmed) {
    incubatorStateDAO.setState(workId, 'SeedReady')
  }
}
