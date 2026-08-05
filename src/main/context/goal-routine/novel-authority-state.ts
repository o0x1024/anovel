import { goalRoutineDAO, novelAuthorityStateDAO } from '../../db'
import type { NovelGoalPersistentState } from './novel-outline-pipeline'

type NovelGoalStateKey = keyof NovelGoalPersistentState
type NovelGoalStateOwner = 'authority' | 'run'

const NOVEL_GOAL_STATE_OWNERS = {
  workflowDefinitionVersion: 'run',
  chapterSkeletonProtocolVersion: 'run',
  chapterSkeletonAuthorityLedger: 'authority',
  autonomousEpoch: 'run',
  causalPlanningRecovery: 'run',
  autonomousChapterEscalations: 'run',
  autonomousTerminal: 'run',
  repairCommitPending: 'run',
  lastCheck: 'authority',
  novelOutline: 'authority',
  volumePlanChecked: 'authority',
  volumeQualityReport: 'authority',
  checkedChapterVolumes: 'authority',
  pendingChapterVolumeGate: 'run',
  chapterVolumeGateCheckpoint: 'run',
  volumeGateDeferredIssues: 'authority',
  chapterVolumeGateResults: 'authority',
  checkedBodyVolumes: 'authority',
  pleasureVolumeFingerprint: 'authority',
  pendingChapterSkeletonBatch: 'run',
  repairPlan: 'run',
  overallRepairRounds: 'run',
  repairStall: 'run',
  titleHookCandidates: 'authority',
  titleHookPreferredIndex: 'authority',
  titleHookApplied: 'authority',
  finalAudit: 'authority',
  chapterExecutionProtocolVersion: 'authority',
  chapterExecutionDeferredIssues: 'authority',
  chapterAcceptanceDeferredIssues: 'authority',
  chapterEditorialDebts: 'authority',
  chapterTransactionBudgets: 'run',
  failure: 'run'
} as const satisfies Record<NovelGoalStateKey, NovelGoalStateOwner>

function parseState(raw: string, label: string): NovelGoalPersistentState {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根节点不是对象')
    }
    return parsed as NovelGoalPersistentState
  } catch (error) {
    throw new Error(`${label}损坏：${error instanceof Error ? error.message : String(error)}`)
  }
}

function selectOwnedState(
  state: NovelGoalPersistentState,
  owner: NovelGoalStateOwner
): NovelGoalPersistentState {
  const selected: NovelGoalPersistentState = {}
  for (const key of Object.keys(NOVEL_GOAL_STATE_OWNERS) as NovelGoalStateKey[]) {
    if (NOVEL_GOAL_STATE_OWNERS[key] !== owner || !(key in state)) continue
    Object.assign(selected, { [key]: state[key] })
  }
  return selected
}

export interface NovelAuthorityMaterialization {
  created: boolean
  revision: number
  sourceRunId: number | null
}

export interface PreparedNovelAuthorityStateUpdate {
  expectedRevision: number
  stateJson: string
}

export function prepareNovelAuthorityStateUpdate(
  workId: number,
  patch: Partial<NovelGoalPersistentState>
): PreparedNovelAuthorityStateUpdate {
  ensureNovelAuthorityState(workId)
  const row = novelAuthorityStateDAO.get(workId)!
  const current = selectOwnedState(
    parseState(row.state_json, `作品 ${workId} 的权威状态`),
    'authority'
  )
  const authorityPatch = selectOwnedState(patch, 'authority')
  return {
    expectedRevision: row.revision,
    stateJson: JSON.stringify({ ...current, ...authorityPatch })
  }
}

function recoverMisroutedNovelRun(
  workId: number,
  authorityState: NovelGoalPersistentState,
  sourceRunId: number | null
): void {
  if (
    !authorityState.novelOutline
    || authorityState.volumePlanChecked !== true
    || sourceRunId == null
  ) return
  const currentRun = goalRoutineDAO.getByWork(workId)
  const sourceRun = goalRoutineDAO.getById(sourceRunId)
  if (
    !currentRun
    || currentRun.id === sourceRunId
    || currentRun.status !== 'paused'
    || currentRun.current_phase !== 'generate_volumes'
    || sourceRun?.current_phase !== 'draft_body'
  ) return
  const currentState = selectOwnedState(
    parseState(currentRun.state_json, `作品 ${workId} 的运行状态`),
    'run'
  )
  if (
    currentState.failure?.phase !== 'generate_volumes'
    || !currentState.failure.message.includes('分卷规划规则已升级，但作品已有章节')
  ) return

  goalRoutineDAO.update(workId, {
    current_phase: 'draft_body',
    state_json: JSON.stringify({ ...currentState, failure: undefined })
  })
  goalRoutineDAO.appendTurn({
    work_id: workId,
    turn_no: currentRun.turn_count,
    phase: 'draft_body',
    action: 'authority_state_recovered',
    summary: `已依据作品权威状态修订恢复历史运行 #${sourceRunId} 的正文生成断点`
  })
}

/**
 * 将旧运行中的作品级事实一次性迁移到独立权威状态。
 * 迁移完成后，运行 state_json 不再作为作品权威状态的读取来源。
 */
export function ensureNovelAuthorityState(workId: number): NovelAuthorityMaterialization {
  const existing = novelAuthorityStateDAO.get(workId)
  if (existing) {
    recoverMisroutedNovelRun(
      workId,
      selectOwnedState(parseState(existing.state_json, `作品 ${workId} 的权威状态`), 'authority'),
      existing.source_run_id
    )
    return {
      created: false,
      revision: existing.revision,
      sourceRunId: existing.source_run_id
    }
  }

  const legacy = novelAuthorityStateDAO.findLatestLegacyState(workId)
  const authority = legacy
    ? selectOwnedState(parseState(legacy.stateJson, `作品 ${workId} 的旧运行状态`), 'authority')
    : {}
  const created = novelAuthorityStateDAO.create(
    workId,
    JSON.stringify(authority),
    legacy?.runId ?? null
  )
  recoverMisroutedNovelRun(workId, authority, created.source_run_id)
  return {
    created: true,
    revision: created.revision,
    sourceRunId: created.source_run_id
  }
}

export function readNovelPersistentState(workId: number): NovelGoalPersistentState {
  ensureNovelAuthorityState(workId)
  const authorityRow = novelAuthorityStateDAO.get(workId)!
  const authority = selectOwnedState(
    parseState(authorityRow.state_json, `作品 ${workId} 的权威状态`),
    'authority'
  )
  const runRaw = goalRoutineDAO.getByWork(workId)?.state_json
  const runState = runRaw
    ? selectOwnedState(parseState(runRaw, `作品 ${workId} 的运行状态`), 'run')
    : {}
  return { ...authority, ...runState }
}

export function updateNovelPersistentState(
  workId: number,
  patch: Partial<NovelGoalPersistentState>
): void {
  ensureNovelAuthorityState(workId)
  const authorityPatch: Partial<NovelGoalPersistentState> = {}
  const runPatch: Partial<NovelGoalPersistentState> = {}

  for (const key of Object.keys(patch) as NovelGoalStateKey[]) {
    const owner = NOVEL_GOAL_STATE_OWNERS[key]
    if (!owner) throw new Error(`未声明小说目标状态字段的所有权：${String(key)}`)
    Object.assign(owner === 'authority' ? authorityPatch : runPatch, { [key]: patch[key] })
  }

  if (Object.keys(authorityPatch).length > 0) {
    const row = novelAuthorityStateDAO.get(workId)!
    const current = selectOwnedState(
      parseState(row.state_json, `作品 ${workId} 的权威状态`),
      'authority'
    )
    novelAuthorityStateDAO.update(
      workId,
      row.revision,
      JSON.stringify({ ...current, ...authorityPatch })
    )
  }

  if (Object.keys(runPatch).length > 0) {
    const raw = goalRoutineDAO.getByWork(workId)?.state_json
    const current = raw
      ? selectOwnedState(parseState(raw, `作品 ${workId} 的运行状态`), 'run')
      : {}
    goalRoutineDAO.update(workId, {
      state_json: JSON.stringify({ ...current, ...runPatch })
    })
  }
}

/** 在工作流定义升级时物理移除误写入作品权威记录的运行态字段。 */
export function normalizeNovelAuthorityStateOwnership(workId: number): boolean {
  ensureNovelAuthorityState(workId)
  const row = novelAuthorityStateDAO.get(workId)!
  const parsed = parseState(row.state_json, `作品 ${workId} 的权威状态`)
  const normalized = selectOwnedState(parsed, 'authority')
  if (JSON.stringify(parsed) === JSON.stringify(normalized)) return false
  novelAuthorityStateDAO.update(workId, row.revision, JSON.stringify(normalized))
  return true
}

export function resetNovelAuthorityState(workId: number): void {
  ensureNovelAuthorityState(workId)
  const row = novelAuthorityStateDAO.get(workId)!
  novelAuthorityStateDAO.update(workId, row.revision, '{}')
}
