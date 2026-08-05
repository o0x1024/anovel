import type { EmotionBlindAssessment } from '../../../shared/emotion-contract'
import { toPlainForIpc } from '../../../shared/ipc-plain'

interface RepairEmotionCandidateOptions {
  workId: number
  chapterId: number
  content: string
  assessment: EmotionBlindAssessment
  maxRounds: number
  onRoundStart?: (round: number) => void
  onCandidate?: (content: string) => Promise<void> | void
  onAssessed?: (assessment: EmotionBlindAssessment) => void
}

export interface RepairEmotionCandidateResult {
  content: string
  assessment: EmotionBlindAssessment
  rounds: number
}

/** 每轮只生成候选并重新盲读；最终正文仍须由用户通过“验收并提交”确认。 */
export async function repairEmotionCandidateUntilChecked(
  options: RepairEmotionCandidateOptions
): Promise<RepairEmotionCandidateResult> {
  let content = options.content
  let assessment = options.assessment

  for (let round = 1; round <= options.maxRounds; round++) {
    options.onRoundStart?.(round)
    const repaired = await window.anovel.invoke(
      'novel:repairEmotionCandidate',
      options.workId,
      options.chapterId,
      content,
      toPlainForIpc(assessment)
    ) as { success: boolean; content?: string; error?: string }
    if (!repaired.success || !repaired.content?.trim()) {
      throw new Error(repaired.error || '情绪定向修复失败')
    }

    content = repaired.content.trim()
    await options.onCandidate?.(content)
    assessment = await window.anovel.invoke(
      'emotion:assessChapter',
      options.workId,
      options.chapterId,
      content,
      false,
      false
    ) as EmotionBlindAssessment
    options.onAssessed?.(assessment)
    if (assessment.passed) {
      return { content, assessment, rounds: round }
    }
  }

  return { content, assessment, rounds: options.maxRounds }
}
