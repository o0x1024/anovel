import { ref } from 'vue'
import type { EmotionBlindAssessment } from '../../../shared/emotion-contract'
import { repairEmotionCandidateUntilChecked } from '../services/emotion-candidate-repair'

interface EmotionCandidateRepairOptions {
  getWorkId: () => number
  getWorkType: () => string | null
  getChapterId: () => number | null
  getContent: () => string
  getAssessment: () => EmotionBlindAssessment | null
  applyCandidate: (chapterId: number, content: string) => Promise<void> | void
  applyAssessment: (assessment: EmotionBlindAssessment) => void
  notify: (tone: 'success' | 'warning' | 'error', message: string) => void
}

/** 管理情绪修复的有限轮次、复验和用户可见状态；不负责提交正式正文。 */
export function useEmotionCandidateRepair(options: EmotionCandidateRepairOptions) {
  const repairingEmotion = ref(false)
  const emotionRepairMsg = ref('')

  async function repairBlockedEmotion() {
    const chapterId = options.getChapterId()
    const initialAssessment = options.getAssessment()
    const content = options.getContent()
    if (
      options.getWorkType() !== 'novel'
      || !chapterId
      || !content.trim()
      || !initialAssessment
      || initialAssessment.passed
      || repairingEmotion.value
    ) return

    repairingEmotion.value = true
    emotionRepairMsg.value = ''
    try {
      const repaired = await repairEmotionCandidateUntilChecked({
        workId: options.getWorkId(),
        chapterId,
        content,
        assessment: initialAssessment,
        maxRounds: 2,
        onRoundStart: round => {
          emotionRepairMsg.value = `正在根据情绪盲读证据定向修复并复验（${round}/2）…`
        },
        onCandidate: candidate => options.applyCandidate(chapterId, candidate),
        onAssessed: options.applyAssessment
      })

      if (repaired.assessment.passed) {
        emotionRepairMsg.value = `情绪盲读已通过（${repaired.assessment.score}分）。修复结果尚未提交，请点击「验收并提交」。`
        options.notify('success', '情绪问题已定向修复并通过复验')
      } else {
        const remaining = repaired.assessment.blocking_issues.join('；')
          || repaired.assessment.repair_instruction
        emotionRepairMsg.value = `两轮修复后仍为 ${repaired.assessment.score} 分：${remaining}`
        options.notify('warning', '情绪修复尚未通过，请查看剩余问题')
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : '情绪定向修复失败'
      emotionRepairMsg.value = message
      options.notify('error', message)
    } finally {
      repairingEmotion.value = false
    }
  }

  function resetEmotionRepair() {
    emotionRepairMsg.value = ''
  }

  return {
    repairingEmotion,
    emotionRepairMsg,
    repairBlockedEmotion,
    resetEmotionRepair
  }
}
