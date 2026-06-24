import { coreSettingDAO } from '../../db'
import {
  incubatorDraftSlotDAO,
  incubatorStateDAO,
  incubatorVersionDAO
} from '../../db/dao/incubator'
import { INCUBATOR_SLOT_LABELS, INCUBATOR_SLOT_KEYS } from '../../../shared/incubator-slots'
import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import type { IncubatorGateReport } from '../../../shared/incubator-types'
import { assertTransition } from './state-machine'
import { runIncubatorGate } from './gate-check'
import { getBranchBaseVersionId } from './version-ops'
import { synthesizeStorylineForFreeze } from './synthesize-storyline'
import type { WorkModelOptions } from '../../../shared/work-model-options'

function getCachedGateReport(workId: number): IncubatorGateReport | null {
  const stateRow = incubatorStateDAO.getByWork(workId)
  if (!stateRow?.last_gate_report_json) return null
  try {
    const parsed = JSON.parse(stateRow.last_gate_report_json) as Partial<IncubatorGateReport>
    if (typeof parsed.passed !== 'boolean') return null
    return {
      passed: parsed.passed,
      filledSlotCount: parsed.filledSlotCount ?? 0,
      serializabilityScore: parsed.serializabilityScore ?? 0,
      conflictClosureScore: parsed.conflictClosureScore ?? 0,
      issues: parsed.issues ?? [],
      suggestions: parsed.suggestions ?? [],
      coherence: parsed.coherence ?? []
    }
  } catch {
    return null
  }
}

export async function freezeIncubatorStorylineVersion(
  workId: number,
  label?: string,
  modelOpts?: WorkModelOptions
): Promise<{ success: boolean; error?: string; versionId?: number }> {
  const frozenCount = incubatorVersionDAO.listByWork(workId).filter(v => v.is_frozen === 1).length
  const resolvedLabel = label ?? `Storyline V${frozenCount + 1}`
  let resolvedBaseId = getBranchBaseVersionId(workId)
  if (resolvedBaseId == null) {
    const prevFrozen = incubatorVersionDAO.getLatestFrozen(workId)
    if (prevFrozen) resolvedBaseId = prevFrozen.id
  }

  // 优先使用缓存的 AI 门禁报告，避免重复调用 AI 导致非确定性结果
  let gate = getCachedGateReport(workId)
  if (gate) {
    console.log(`[freeze] workId=${workId} 使用缓存门禁报告: passed=${gate.passed}, issues=${gate.issues.length}, coherence=${gate.coherence.length}`)
  } else {
    console.log(`[freeze] workId=${workId} 无缓存门禁报告，重新运行 AI 门禁`)
    gate = await runIncubatorGate(workId, undefined, modelOpts)
    console.log(`[freeze] workId=${workId} AI 门禁结果: passed=${gate.passed}, issues=${gate.issues.length}`)
  }

  if (!gate.passed) {
    const reasons: string[] = []
    const blockers = (gate.coherence ?? []).filter(c => c.severity === 'blocking')
    if (blockers.length) {
      reasons.push(...blockers.map(b => `[${b.slotKey}] ${b.issue}`))
    }
    if (gate.issues.length) {
      reasons.push(...gate.issues)
    }
    const detail = reasons.length ? reasons.join('；') : '门禁未通过，请运行 AI 门禁查看详情'
    return {
      success: false,
      error: `门禁未通过：${detail}`
    }
  }

  const slots = incubatorDraftSlotDAO.listActiveByWork(workId)
  const slotMap: Record<string, string> = {}
  for (const key of INCUBATOR_SLOT_KEYS) {
    const row = slots.find(s => s.slot_key === key)
    slotMap[key] = row?.content?.trim() ?? ''
  }

  const synthesis = await synthesizeStorylineForFreeze(workId, slotMap, modelOpts)

  const snapshot = {
    slots: slotMap,
    gate,
    frozenAt: new Date().toISOString(),
    synthesizedSummary: synthesis?.synthesizedSummary ?? null,
    qualitySnapshot: synthesis?.qualitySnapshot ?? null
  }

  if (resolvedBaseId != null) {
    const base = incubatorVersionDAO.getById(resolvedBaseId)
    if (!base || base.work_id !== workId) resolvedBaseId = null
  }

  const versionId = incubatorVersionDAO.create({
    workId,
    label: resolvedLabel,
    snapshotJson: JSON.stringify(snapshot),
    baseVersionId: resolvedBaseId,
    isFrozen: true
  })

  incubatorStateDAO.setBranchBaseVersion(workId, null)

  const summaryLines = INCUBATOR_SLOT_KEYS
    .filter((k: IncubatorSlotKey) => slotMap[k])
    .map((k: IncubatorSlotKey) => `## ${INCUBATOR_SLOT_LABELS[k]}\n${slotMap[k]}`)

  const ideaParts = ['# 主线故事线（冻结版）']
  if (synthesis?.synthesizedSummary) {
    ideaParts.push('## 统合主线摘要', synthesis.synthesizedSummary)
    if (synthesis.qualitySnapshot) {
      ideaParts.push('## 质量评分卡', synthesis.qualitySnapshot)
    }
    ideaParts.push('---', '## 槽位明细', ...summaryLines)
  } else {
    ideaParts.push(...summaryLines)
  }

  const ideaCompat = ideaParts.join('\n\n')
  coreSettingDAO.upsert(workId, 'idea', ideaCompat)

  const stateRow = incubatorStateDAO.ensure(workId)
  assertTransition(
    stateRow.state as import('../../../shared/incubator-types').IncubatorWorkflowState,
    'V1Frozen'
  )
  incubatorStateDAO.setState(workId, 'V1Frozen')

  return { success: true, versionId }
}
