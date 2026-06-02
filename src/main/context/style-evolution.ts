import { volumeChapterDAO } from '../db'
import {
  parseStyleEvolutionCurve,
  resolvePhaseForProgress,
  type StyleEvolutionCurve
} from '../../shared/style-evolution'

/** 计算章节在全书中的进度（1-based index / total）→ 0-100 */
export function computeWorkChapterProgress(workId: number, chapterId?: number): number {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  if (!chapters.length) return 50

  if (!chapterId) {
    const withContent = chapters.filter(c => (c.content?.trim().length ?? 0) > 0)
    const idx = withContent.length > 0 ? withContent.length - 1 : 0
    return Math.round(((idx + 1) / chapters.length) * 100)
  }

  const index = chapters.findIndex(c => c.id === chapterId)
  if (index < 0) return 50
  return Math.round(((index + 1) / chapters.length) * 100)
}

export function formatEvolutionPrompt(
  curveJson: string | null | undefined,
  progressPercent: number
): string {
  const curve = parseStyleEvolutionCurve(curveJson)
  if (!curve?.enabled) return ''

  const phase = resolvePhaseForProgress(curve, progressPercent)
  const lines = [
    '【文风进化阶段 - 当前全书进度约束】',
    `- 全书进度约 ${progressPercent}%（${phase.label}）`,
    `- ${phase.tone_note}`
  ]
  if (phase.pacing_note) lines.push(`- ${phase.pacing_note}`)
  if (phase.extra_rules?.length) {
    for (const r of phase.extra_rules) lines.push(`- ${r}`)
  }
  return ''
  // return lines.join('\n')
}

export function getWorkEvolutionCurve(evolutionCurveJson: string | null | undefined): StyleEvolutionCurve | null {
  return parseStyleEvolutionCurve(evolutionCurveJson)
}
