import { toPlainForIpc } from '../../shared/ipc-plain'
import type { WorkModelOptions } from '../../shared/work-model-options'
import type {
  IncubatorAdoptMode,
  IncubatorAdoptToSlotInput,
  IncubatorAdoptToSlotResult,
  IncubatorCandidateSourceStep,
  IncubatorCandidateStatus,
  IncubatorVersionDetail,
  IncubatorWorkspaceState
} from '../../shared/incubator-types'
import { INCUBATOR_SLOT_KEYS, INCUBATOR_SLOT_LABELS, isIncubatorSlotKey } from '../../shared/incubator-slots'
import type { IncubatorSlotKey } from '../../shared/incubator-slots'
import { incubatorCandidateDAO } from '../db/dao/incubator'
import { adoptCandidateToSlot, undoLastAdopt } from '../context/incubator/adopt-to-slot'
import { runIncubatorGate } from '../context/incubator/gate-check'
import { freezeIncubatorStorylineVersion } from '../context/incubator/freeze-version'
import {
  getIncubatorWorkspaceState,
  setIncubatorSeed
} from '../context/incubator/workspace-state'
import {
  persistExpansionAsCandidates,
  persistVariantsAsCandidates,
  persistSlotAnalysisAsCandidates,
  ensureCandidateFromManual
} from '../context/incubator/persist-candidates'
import { parseExpansionVersions } from '../context/parse-expansion'
import { parseIncubatorVariants } from '../context/parse-variants'
import {
  applyUserScoreAdjustment,
  rescoreAllCandidates,
  rescoreCandidate
} from '../context/incubator/score-candidate'
import { updateDraftSlotContent } from '../context/incubator/update-slot'
import { parseDiagnosePatches } from '../context/incubator/parse-diagnose-patches'
import { applyDiagnosePatchesToSlots } from '../context/incubator/apply-diagnose-patches'
import { applyGateReplacements } from '../context/incubator/apply-gate-replacements'
import { runGateFix } from '../context/incubator/gate-fix'
import {
  branchFromIncubatorVersion,
  compareIncubatorVersions,
  getIncubatorVersionDetail,
  listIncubatorVersions,
  restoreIncubatorVersion
} from '../context/incubator/version-ops'
import { clearIncubatorAnalysisResults } from '../context/incubator/clear-analysis-results'
import { safeIpcHandle } from './ipc-safe'

function workspaceAt(workId: number): IncubatorWorkspaceState {
  return toPlainForIpc(getIncubatorWorkspaceState(workId))
}

/** 渲染进程仅需 success/error，勿回传 ORM 行对象 */
function adoptResultForIpc(result: IncubatorAdoptToSlotResult): {
  success: boolean
  error?: string
  workflowState?: IncubatorAdoptToSlotResult['workflowState']
} {
  return {
    success: result.success,
    error: result.error,
    workflowState: result.workflowState
  }
}

export function registerIncubatorIpcHandlers(): void {
  safeIpcHandle('incubator:getState', (_e, workId) => workspaceAt(workId as number))

  safeIpcHandle('incubator:setSeed', (_e, workId, content) => {
    setIncubatorSeed(workId as number, content as string)
    return workspaceAt(workId as number)
  })

  safeIpcHandle(
    'incubator:listCandidates',
    (_e, workId, filters) =>
      incubatorCandidateDAO.listByWork(workId as number, filters as {
        status?: IncubatorCandidateStatus
        sourceStep?: string
      })
  )

  safeIpcHandle('incubator:adoptToSlot', (_e, input) =>
    adoptResultForIpc(adoptCandidateToSlot(input as IncubatorAdoptToSlotInput)))

  safeIpcHandle('incubator:undoLastAdopt', (_e, workId) => {
    const result = undoLastAdopt(workId as number)
    return { ...result, workspace: workspaceAt(workId as number) }
  })

  safeIpcHandle('incubator:runGate', async (_e, workId, userInstruction, modelOpts) => {
    const report = await runIncubatorGate(
      workId as number,
      userInstruction as string | undefined,
      { webContents: _e.sender },
      modelOpts as WorkModelOptions | undefined
    )
    return { report, workspace: workspaceAt(workId as number) }
  })

  safeIpcHandle('incubator:freezeVersion', async (_e, workId, label, modelOpts?: WorkModelOptions) => {
    const result = await freezeIncubatorStorylineVersion(workId as number, label as string | undefined, modelOpts)
    return { ...result, workspace: workspaceAt(workId as number) }
  })

  safeIpcHandle(
    'incubator:persistVariants',
    async (_e, workId, items) => {
      const ids = await persistVariantsAsCandidates(
        workId as number,
        items as { title: string; summary: string; dimension?: string }[]
      )
      return { ids, workspace: workspaceAt(workId as number) }
    }
  )

  safeIpcHandle(
    'incubator:persistExpansion',
    async (_e, workId, versions) => {
      const ids = await persistExpansionAsCandidates(
        workId as number,
        versions as { title: string; summary: string; highlights?: string; audience?: string }[]
      )
      return { ids, workspace: workspaceAt(workId as number) }
    }
  )

  safeIpcHandle(
    'incubator:persistSlotAnalysis',
    async (_e, workId, sourceStep, versions) => {
      const ids = await persistSlotAnalysisAsCandidates(
        workId as number,
        sourceStep as IncubatorCandidateSourceStep,
        versions as { title: string; summary: string }[]
      )
      return { ids, workspace: workspaceAt(workId as number) }
    }
  )

  safeIpcHandle(
    'incubator:registerManualCandidate',
    async (_e, workId, sourceStep, payload) => {
      const id = await ensureCandidateFromManual(
        workId as number,
        sourceStep as import('../../shared/incubator-types').IncubatorCandidateSourceStep,
        payload as {
          title: string
          summary: string
          dimension?: string | null
          highlights?: string | null
          audience?: string | null
        }
      )
      return { id, workspace: workspaceAt(workId as number) }
    }
  )

  safeIpcHandle(
    'incubator:syncParsedCandidates',
    async (_e, workId, source, raw, legacyFallback = false) => {
      const wid = workId as number
      if (source === 'variants') {
        const items = parseIncubatorVariants(raw as string, legacyFallback as boolean)
        await persistVariantsAsCandidates(wid, items)
      } else {
        const versions = parseExpansionVersions(raw as string)
        await persistExpansionAsCandidates(wid, versions)
      }
      return workspaceAt(wid)
    }
  )

  safeIpcHandle('incubator:deleteCandidate', (_e, workId, candidateId) => {
    const wid = workId as number
    const cid = candidateId as number
    const row = incubatorCandidateDAO.getById(cid)
    if (!row || row.work_id !== wid) throw new Error('候选不存在')
    incubatorCandidateDAO.deleteById(cid)
    return workspaceAt(wid)
  })

  safeIpcHandle('incubator:deleteCandidates', (_e, workId, candidateIds) => {
    const wid = workId as number
    const ids = candidateIds as number[]
    const validIds = ids.filter(id => {
      const row = incubatorCandidateDAO.getById(id)
      return row && row.work_id === wid
    })
    const deleted = incubatorCandidateDAO.deleteByIds(validIds)
    return { deleted, workspace: workspaceAt(wid) }
  })

  safeIpcHandle('incubator:clearAnalysisResults', (_e, workId) => {
    const wid = workId as number
    const result = clearIncubatorAnalysisResults(wid)
    return { ...result, workspace: workspaceAt(wid) }
  })

  safeIpcHandle('incubator:rescoreCandidate', async (_e, workId, candidateId) => {
    const wid = workId as number
    const cid = candidateId as number
    const row = incubatorCandidateDAO.getById(cid)
    if (!row || row.work_id !== wid) throw new Error('候选不存在')
    await rescoreCandidate(cid)
    return workspaceAt(wid)
  })

  safeIpcHandle('incubator:rescoreAll', async (_e, workId) => {
    const wid = workId as number
    const count = await rescoreAllCandidates(wid)
    return { count, workspace: workspaceAt(wid) }
  })

  safeIpcHandle('incubator:setUserScoreAdjustment', async (_e, workId, candidateId, adjustment) => {
    const result = await applyUserScoreAdjustment(
      workId as number,
      candidateId as number,
      adjustment as number
    )
    return { ...result, workspace: workspaceAt(workId as number) }
  })

  safeIpcHandle('incubator:updateSlotContent', (_e, workId, slotKey, content) => {
    updateDraftSlotContent(workId as number, slotKey as string, content as string)
    return workspaceAt(workId as number)
  })

  safeIpcHandle('incubator:parseDiagnosePatches', (_e, content) =>
    parseDiagnosePatches(content as string))

  safeIpcHandle('incubator:applyDiagnosePatches', (_e, workId, patches) => {
    const result = applyDiagnosePatchesToSlots(
      workId as number,
      patches as import('../context/incubator/parse-diagnose-patches').IncubatorDiagnosePatch[]
    )
    return { ...result, workspace: workspaceAt(workId as number) }
  })

  safeIpcHandle('incubator:applyGateReplacements', (_e, workId, items) => {
    const result = applyGateReplacements(
      workId as number,
      items as import('../context/incubator/apply-gate-replacements').GateReplacementInput[]
    )
    return { ...result, workspace: workspaceAt(workId as number) }
  })

  safeIpcHandle('incubator:runGateFix', async (_e, workId, gateReport, modelOpts) => {
    const result = await runGateFix(
      workId as number,
      gateReport as import('../../shared/incubator-types').IncubatorGateReport,
      { webContents: _e.sender, sessionTitle: '门禁自动修复' },
      modelOpts as WorkModelOptions | undefined
    )
    return { ...result, workspace: workspaceAt(workId as number) }
  })

  safeIpcHandle('incubator:listVersions', (_e, workId) =>
    listIncubatorVersions(workId as number))

  safeIpcHandle('incubator:getVersionDetail', (_e, workId, versionId) => {
    const detail = getIncubatorVersionDetail(workId as number, versionId as number)
    if (!detail) return null
    const slotPreviews = INCUBATOR_SLOT_KEYS
      .map((key: IncubatorSlotKey) => ({
        slotKey: key,
        label: INCUBATOR_SLOT_LABELS[key],
        content: detail.snapshot.slots[key]?.trim() ?? ''
      }))
      .filter(s => s.content)
    // 解析冻结时存储的门禁报告快照
    let gate: IncubatorVersionDetail['gate'] = null
    if (detail.snapshot.gate) {
      const g = detail.snapshot.gate as unknown as Record<string, unknown>
      gate = {
        passed: !!g.passed,
        filledSlotCount: (g.filledSlotCount as number) ?? slotPreviews.length,
        serializabilityScore: (g.serializabilityScore as number) ?? 0,
        conflictClosureScore: (g.conflictClosureScore as number) ?? 0,
        issues: Array.isArray(g.issues) ? g.issues as string[] : [],
        suggestions: Array.isArray(g.suggestions) ? g.suggestions as string[] : [],
        coherence: Array.isArray(g.coherence)
          ? (g.coherence as Array<Record<string, unknown>>)
              .filter(c =>
                typeof c.slotKey === 'string' &&
                typeof c.severity === 'string' &&
                typeof c.issue === 'string' &&
                typeof c.suggestion === 'string'
              )
              .map(c => ({
                slotKey: c.slotKey as IncubatorSlotKey,
                severity: c.severity as 'blocking' | 'warning',
                issue: c.issue as string,
                suggestion: c.suggestion as string
              }))
          : []
      }
    }
    return {
      version: detail.version,
      filledSlotCount: slotPreviews.length,
      slotPreviews,
      synthesizedSummary: detail.snapshot.synthesizedSummary ?? null,
      qualitySnapshot: detail.snapshot.qualitySnapshot ?? null,
      gate
    }
  })

  safeIpcHandle('incubator:restoreVersion', (_e, workId, versionId) => {
    const result = restoreIncubatorVersion(workId as number, versionId as number)
    return { ...result, workspace: workspaceAt(workId as number) }
  })

  safeIpcHandle('incubator:branchFromVersion', (_e, workId, versionId) => {
    const result = branchFromIncubatorVersion(workId as number, versionId as number)
    return { ...result, workspace: workspaceAt(workId as number) }
  })

  safeIpcHandle('incubator:compareVersions', (_e, workId, versionIdA, versionIdB) =>
    compareIncubatorVersions(
      workId as number,
      versionIdA as number,
      versionIdB as number
    ))

  safeIpcHandle(
    'incubator:adoptLegacyToSlot',
    async (_e, workId, payload, slotKey, mode) => {
      const sk = slotKey as string
      if (!isIncubatorSlotKey(sk)) {
        return { success: false, error: '无效的槽位' }
      }
      const p = payload as {
        title: string
        summary: string
        dimension?: string | null
        highlights?: string | null
        audience?: string | null
        sourceStep: 'variants' | 'expand'
      }
      const candidateId = await ensureCandidateFromManual(
        workId as number,
        p.sourceStep,
        p
      )
      return adoptResultForIpc(
        adoptCandidateToSlot({
          workId: workId as number,
          candidateId,
          slotKey: sk,
          mode: mode as IncubatorAdoptMode
        })
      )
    }
  )
}
