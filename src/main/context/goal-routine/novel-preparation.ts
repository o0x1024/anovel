import { coreSettingDAO, goalRoutineDAO, volumeChapterDAO } from '../../db'
import { loadCharacterCards, validateCharacterCards } from '../character-cards'
import { getSettingsQualityStatus } from '../settings-quality'
import { loadWritingPlan } from '../writing-plan'
import type { GoalRoutinePhase } from '../../../shared/goal-routine-phases'
import { readNovelGoalState } from './novel-outline-pipeline'
import { shouldGenerateNovelGoldenFinger } from './novel-golden-finger-policy'
import { resolveNovelPreparationPhase } from './novel-goal-policy'
import { ensureEmotionEngine } from './emotion-engine'

export const NOVEL_SETTING_TYPES = [
  'protagonist',
  'golden_finger',
  'world_pressure',
  'conflict_engine',
  'pleasure_engine',
  'supporting_cast',
  'main_plotline'
] as const

export function safeNovelPreparationPhase(
  workId: number,
  requestedPhase: GoalRoutinePhase,
  goal: string,
  goldenFingerRequired: boolean,
  checkEmotionContract = true
): GoalRoutinePhase {
  const mainline = coreSettingDAO.getByType(workId, 'main_plotline')?.content?.trim()
    || coreSettingDAO.getByType(workId, 'idea')?.content?.trim()
    || ''
  const requireGoldenFinger = shouldGenerateNovelGoldenFinger({
    userRequired: goldenFingerRequired,
    goal,
    mainline
  })
  const requiredSettingTypes = requireGoldenFinger
    ? [...NOVEL_SETTING_TYPES]
    : NOVEL_SETTING_TYPES.filter(type => type !== 'golden_finger')
  const settingsReady = requiredSettingTypes.every(type => Boolean(coreSettingDAO.getByType(workId, type)?.content?.trim()))
  const cards = loadCharacterCards(workId)
  const targetChapters = loadWritingPlan(workId).targetChapters
  const runtime = readNovelGoalState(workId)
  return resolveNovelPreparationPhase({
    requestedPhase,
    settingsReady,
    characterCardsReady: cards.length > 0 && validateCharacterCards(cards).valid,
    emotionEngineReady: !checkEmotionContract
      || Boolean(coreSettingDAO.getByType(workId, 'emotion_engine')?.content?.trim()),
    settingsGateReady: getSettingsQualityStatus(workId).canProceed,
    volumePlanReady: Boolean(
      runtime.novelOutline
      && runtime.novelOutline.targetChapters === targetChapters
      && runtime.volumePlanChecked
    ),
    hasChapters: volumeChapterDAO.listChaptersByWork(workId).length > 0
  }) as GoalRoutinePhase
}

export async function runNovelEmotionEnginePreparation(input: {
  workId: number
  turn: number
  enabled: boolean
  goal: string
  signal: AbortSignal
  emit: (message: string, status: string) => void
}): Promise<void> {
  if (!input.enabled) {
    goalRoutineDAO.appendTurn({
      work_id: input.workId,
      turn_no: input.turn,
      phase: 'emotion_engine_gate',
      action: 'emotion_contract_disabled',
      summary: '用户已关闭情绪合同约束，跳过情绪发动机门禁'
    })
    input.emit('情绪合同约束已关闭，跳过情绪发动机门禁', 'running')
    return
  }
  const result = await ensureEmotionEngine(
    input.workId,
    input.goal,
    'novel',
    input.signal,
    message => input.emit(message, 'running')
  )
  goalRoutineDAO.appendTurn({
    work_id: input.workId,
    turn_no: input.turn,
    phase: 'emotion_engine_gate',
    action: 'emotion_engine_gate',
    score: result.score,
    summary: `情绪发动机通过（${result.score}分，${result.rounds}轮）`
  })
  input.emit(`情绪发动机通过（${result.score}分）`, 'running')
}
