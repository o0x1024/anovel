import { coreSettingDAO } from '../../db'
import {
  incubatorDraftSlotDAO,
  incubatorStateDAO,
  incubatorVersionDAO
} from '../../db/dao/incubator'
import { INCUBATOR_SLOT_LABELS, INCUBATOR_SLOT_KEYS } from '../../../shared/incubator-slots'
import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import { assertTransition } from './state-machine'
import { runIncubatorGate } from './gate-check'
import { getBranchBaseVersionId } from './version-ops'
import { synthesizeStorylineForFreeze } from './synthesize-storyline'

export async function freezeIncubatorStorylineVersion(
  workId: number,
  label?: string
): Promise<{ success: boolean; error?: string; versionId?: number }> {
  const frozenCount = incubatorVersionDAO.listByWork(workId).filter(v => v.is_frozen === 1).length
  const resolvedLabel = label ?? `Storyline V${frozenCount + 1}`
  let resolvedBaseId = getBranchBaseVersionId(workId)
  if (resolvedBaseId == null) {
    const prevFrozen = incubatorVersionDAO.getLatestFrozen(workId)
    if (prevFrozen) resolvedBaseId = prevFrozen.id
  }
  const gate = runIncubatorGate(workId)
  if (!gate.passed) {
    return {
      success: false,
      error: `门禁未通过：${gate.issues.join('；')}`
    }
  }

  const slots = incubatorDraftSlotDAO.listActiveByWork(workId)
  const slotMap: Record<string, string> = {}
  for (const key of INCUBATOR_SLOT_KEYS) {
    const row = slots.find(s => s.slot_key === key)
    slotMap[key] = row?.content?.trim() ?? ''
  }

  const synthesis = await synthesizeStorylineForFreeze(workId, slotMap)

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
