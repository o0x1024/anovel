import { ref, type Ref } from 'vue'
import { useBodyGenerationModel } from '../useBodyGenerationModel'
import type {
  IncubatorGateReport,
  IncubatorVersionCompareResult,
  IncubatorVersionDetail,
  IncubatorStorylineVersion,
  IncubatorWorkspaceState
} from '../../../shared/incubator-types'

export function useIncubatorState(workId: Ref<number> | number) {
  const workspace = ref<IncubatorWorkspaceState | null>(null)
  const loading = ref(false)
  const gateRunning = ref(false)
  const freezing = ref(false)
  const undoing = ref(false)
  const lastGateReport = ref<IncubatorGateReport | null>(null)
  const actionError = ref('')

  function wid(): number {
    const id = typeof workId === 'number' ? workId : workId.value
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`无效的作品 ID: ${String(id)}`)
    }
    return id
  }

  const { modelParams: bodyModelParams } = useBodyGenerationModel(wid)

  async function refresh(): Promise<IncubatorWorkspaceState> {
    loading.value = true
    try {
      workspace.value = await window.anovel.invoke(
        'incubator:getState',
        wid()
      ) as IncubatorWorkspaceState
      lastGateReport.value = workspace.value.gateSummary
      return workspace.value
    } finally {
      loading.value = false
    }
  }

  async function setSeed(content: string): Promise<IncubatorWorkspaceState> {
    workspace.value = await window.anovel.invoke(
      'incubator:setSeed',
      wid(),
      content
    ) as IncubatorWorkspaceState
    return workspace.value
  }

  async function runGate(userInstruction?: string): Promise<IncubatorGateReport> {
    gateRunning.value = true
    actionError.value = ''
    try {
      const res = await window.anovel.invoke('incubator:runGate', wid(), userInstruction, bodyModelParams()) as {
        report: IncubatorGateReport
        workspace: IncubatorWorkspaceState
      }
      workspace.value = res.workspace
      lastGateReport.value = res.report
      return res.report
    } catch (e) {
      actionError.value = String(e)
      throw e
    } finally {
      gateRunning.value = false
    }
  }

  async function freezeVersion(label?: string): Promise<boolean> {
    freezing.value = true
    actionError.value = ''
    try {
      const res = await window.anovel.invoke(
        'incubator:freezeVersion',
        wid(),
        label,
        bodyModelParams()
      ) as { success: boolean; error?: string; workspace?: IncubatorWorkspaceState }
      // 无论成功与否都更新 workspace，确保门禁报告等状态同步到前端
      if (res.workspace) {
        workspace.value = res.workspace
        lastGateReport.value = res.workspace.gateSummary
      }
      if (!res.success) {
        actionError.value = res.error || '冻结失败'
        return false
      }
      return true
    } finally {
      freezing.value = false
    }
  }

  async function undoLastAdopt(): Promise<boolean> {
    undoing.value = true
    try {
      const res = await window.anovel.invoke('incubator:undoLastAdopt', wid()) as {
        success: boolean
        error?: string
        workspace?: IncubatorWorkspaceState
      }
      if (!res.success) {
        actionError.value = res.error || '无法撤销'
        return false
      }
      workspace.value = res.workspace ?? (await refresh())
      return true
    } finally {
      undoing.value = false
    }
  }

  async function rescoreAll(): Promise<void> {
    const res = await window.anovel.invoke('incubator:rescoreAll', wid()) as {
      workspace: IncubatorWorkspaceState
    }
    workspace.value = res.workspace
  }

  async function setUserScoreAdjustment(candidateId: number, adjustment: number): Promise<void> {
    const res = await window.anovel.invoke(
      'incubator:setUserScoreAdjustment',
      wid(),
      candidateId,
      adjustment
    ) as { workspace: IncubatorWorkspaceState }
    workspace.value = res.workspace
  }

  async function deleteCandidate(candidateId: number): Promise<void> {
    workspace.value = await window.anovel.invoke(
      'incubator:deleteCandidate',
      wid(),
      candidateId
    ) as IncubatorWorkspaceState
  }

  async function deleteCandidates(candidateIds: number[]): Promise<number> {
    const res = await window.anovel.invoke(
      'incubator:deleteCandidates',
      wid(),
      candidateIds
    ) as { deleted: number; workspace: IncubatorWorkspaceState }
    workspace.value = res.workspace
    return res.deleted
  }

  async function updateSlotContent(slotKey: string, content: string): Promise<void> {
    workspace.value = await window.anovel.invoke(
      'incubator:updateSlotContent',
      wid(),
      slotKey,
      content
    ) as IncubatorWorkspaceState
  }

  async function listVersions(): Promise<IncubatorStorylineVersion[]> {
    return window.anovel.invoke('incubator:listVersions', wid()) as Promise<IncubatorStorylineVersion[]>
  }

  async function getVersionDetail(versionId: number): Promise<IncubatorVersionDetail | null> {
    return window.anovel.invoke(
      'incubator:getVersionDetail',
      wid(),
      versionId
    ) as Promise<IncubatorVersionDetail | null>
  }

  async function restoreVersion(versionId: number): Promise<boolean> {
    const res = await window.anovel.invoke(
      'incubator:restoreVersion',
      wid(),
      versionId
    ) as { success: boolean; error?: string; workspace?: IncubatorWorkspaceState }
    if (!res.success) {
      actionError.value = res.error || '恢复失败'
      return false
    }
    workspace.value = res.workspace ?? (await refresh())
    return true
  }

  async function branchFromVersion(versionId: number): Promise<boolean> {
    const res = await window.anovel.invoke(
      'incubator:branchFromVersion',
      wid(),
      versionId
    ) as { success: boolean; error?: string; workspace?: IncubatorWorkspaceState }
    if (!res.success) {
      actionError.value = res.error || '分支失败'
      return false
    }
    workspace.value = res.workspace ?? (await refresh())
    return true
  }

  async function compareVersions(
    versionIdA: number,
    versionIdB: number
  ): Promise<IncubatorVersionCompareResult | null> {
    return window.anovel.invoke(
      'incubator:compareVersions',
      wid(),
      versionIdA,
      versionIdB
    ) as Promise<IncubatorVersionCompareResult | null>
  }

  return {
    workspace,
    loading,
    gateRunning,
    freezing,
    undoing,
    lastGateReport,
    actionError,
    refresh,
    setSeed,
    runGate,
    freezeVersion,
    undoLastAdopt,
    rescoreAll,
    setUserScoreAdjustment,
    deleteCandidate,
    deleteCandidates,
    updateSlotContent,
    listVersions,
    getVersionDetail,
    restoreVersion,
    branchFromVersion,
    compareVersions
  }
}
