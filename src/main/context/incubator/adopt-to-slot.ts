import {
  INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE
} from '../../../shared/incubator-gate'
import type {
  IncubatorAdoptMode,
  IncubatorAdoptToSlotInput,
  IncubatorAdoptToSlotResult,
  IncubatorLastAdoptAction
} from '../../../shared/incubator-types'
import { isIncubatorSlotKey } from '../../../shared/incubator-slots'
import {
  incubatorCandidateDAO,
  incubatorDraftSlotDAO,
  incubatorScoreDAO,
  incubatorStateDAO
} from '../../db/dao/incubator'
import { workDAO } from '../../db'
import { applyStatePathAfterAdopt } from './state-machine'
import { heuristicScoreCandidate } from './heuristic-score'

function formatCandidateBlock(
  title: string,
  summary: string,
  dimension?: string | null,
  highlights?: string | null,
  audience?: string | null
): string {
  return [
    `【${title}】`,
    dimension ? `维度：${dimension}` : '',
    summary,
    highlights ? `亮点：${highlights}` : '',
    audience ? `受众：${audience}` : ''
  ].filter(Boolean).join('\n\n')
}

export function adoptCandidateToSlot(input: IncubatorAdoptToSlotInput): IncubatorAdoptToSlotResult {
  const { workId, candidateId, mode } = input
  if (!isIncubatorSlotKey(input.slotKey)) {
    return { success: false, error: '无效的槽位' }
  }

  const candidate = incubatorCandidateDAO.getById(candidateId)
  if (!candidate || candidate.work_id !== workId) {
    return { success: false, error: '候选不存在' }
  }

  let latest = incubatorScoreDAO.getLatestByCandidate(candidateId)
  if (!latest) {
    incubatorScoreDAO.create(heuristicScoreCandidate(candidate))
    latest = incubatorScoreDAO.getLatestByCandidate(candidateId)
  }

  if (mode !== 'pool_only' && latest && latest.final_total < INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE) {
    return {
      success: false,
      error: `候选总分 ${latest.final_total} 低于入槽阈值 ${INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE}，可先调整评分或仅加入候选池`
    }
  }

  const excerpt = input.excerpt?.trim()
  const block = excerpt || formatCandidateBlock(
    candidate.title,
    candidate.summary,
    candidate.dimension,
    candidate.highlights,
    candidate.audience
  )

  const stateRow = incubatorStateDAO.ensure(workId)
  const fromState = stateRow.state as import('../../../shared/incubator-types').IncubatorWorkflowState

  if (mode === 'pool_only') {
    incubatorCandidateDAO.setStatus(candidateId, 'adopted')
    return { success: true, workflowState: fromState }
  }

  const existing = incubatorDraftSlotDAO.getActiveSlot(workId, input.slotKey)
  const previousContent = existing?.content ?? ''

  let nextContent = block
  if (mode === 'append_slot' && previousContent.trim()) {
    nextContent = `${previousContent.trim()}\n\n---\n${block}`
  }

  incubatorStateDAO.setLastAdopt(
    workId,
    JSON.stringify({
      slotKey: input.slotKey,
      previousContent,
      candidateId,
      mode
    } satisfies IncubatorLastAdoptAction)
  )

  const slotRow = incubatorDraftSlotDAO.upsertActiveSlot({
    workId,
    slotKey: input.slotKey,
    content: nextContent,
    sourceCandidateId: candidateId
  })

  incubatorCandidateDAO.setStatus(candidateId, 'adopted')

  const filled = incubatorDraftSlotDAO.countFilledSlots(workId)
  const filledSlotKeys = incubatorDraftSlotDAO.listFilledSlotKeys(workId)
  const toState = applyStatePathAfterAdopt(fromState, filled, filledSlotKeys)
  incubatorStateDAO.setState(workId, toState)

  return {
    success: true,
    slot: {
      id: slotRow.id,
      workId: slotRow.work_id,
      slotKey: input.slotKey,
      content: slotRow.content,
      sourceCandidateId: slotRow.source_candidate_id,
      status: 'active',
      versionTag: slotRow.version_tag,
      updateTime: slotRow.update_time ?? null
    },
    workflowState: toState
  }
}

export function undoLastAdopt(workId: number): { success: boolean; error?: string } {
  const row = incubatorStateDAO.getByWork(workId)
  if (!row?.last_adopt_json) {
    return { success: false, error: '没有可撤销的采纳操作' }
  }

  let action: IncubatorLastAdoptAction
  try {
    action = JSON.parse(row.last_adopt_json) as IncubatorLastAdoptAction
  } catch {
    return { success: false, error: '撤销记录损坏' }
  }

  if (!isIncubatorSlotKey(action.slotKey)) {
    return { success: false, error: '无效的槽位记录' }
  }

  if (action.previousContent.trim()) {
    incubatorDraftSlotDAO.upsertActiveSlot({
      workId,
      slotKey: action.slotKey,
      content: action.previousContent,
      sourceCandidateId: null
    })
  } else {
    const existing = incubatorDraftSlotDAO.getActiveSlot(workId, action.slotKey)
    if (existing) {
      incubatorDraftSlotDAO.upsertActiveSlot({
        workId,
        slotKey: action.slotKey,
        content: '',
        sourceCandidateId: null
      })
    }
  }

  incubatorStateDAO.setLastAdopt(workId, null)
  incubatorStateDAO.setState(workId, 'Composing')
  return { success: true }
}
