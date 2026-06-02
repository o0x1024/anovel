/** 作品内文风随章节进度渐变 */
export interface StyleEvolutionPhase {
  /** 全书进度上限（0-100，含） */
  until_progress: number
  label: string
  tone_note: string
  pacing_note?: string
  extra_rules?: string[]
}

export interface StyleEvolutionCurve {
  enabled: boolean
  phases: StyleEvolutionPhase[]
}

export function parseStyleEvolutionCurve(json: string | null | undefined): StyleEvolutionCurve | null {
  if (!json?.trim()) return null
  try {
    const parsed = JSON.parse(json) as StyleEvolutionCurve
    if (!parsed?.phases?.length) return null
    return {
      enabled: parsed.enabled !== false,
      phases: parsed.phases
        .map(p => ({
          until_progress: Math.min(100, Math.max(0, Number(p.until_progress) || 0)),
          label: p.label ?? '',
          tone_note: p.tone_note ?? '',
          pacing_note: p.pacing_note,
          extra_rules: p.extra_rules ?? []
        }))
        .sort((a, b) => a.until_progress - b.until_progress)
    }
  } catch {
    return null
  }
}

export function defaultStyleEvolutionCurve(): StyleEvolutionCurve {
  return {
    enabled: true,
    phases: [
      {
        until_progress: 30,
        label: '前期',
        tone_note: '',
        pacing_note: ''
      },
      {
        until_progress: 70,
        label: '中期',
        tone_note: '按标准节奏推进，冲突与回报密度正常',
        pacing_note: '执行标准节奏约束'
      },
      {
        until_progress: 100,
        label: '后期',
        tone_note: '高潮密集，冲突升级加快，章末钩子更强',
        pacing_note: '冲突间隔约为标准值的 0.7 倍，强化章末悬念'
      }
    ]
  }
}

export function resolvePhaseForProgress(
  curve: StyleEvolutionCurve,
  progressPercent: number
): StyleEvolutionPhase {
  const p = Math.min(100, Math.max(0, progressPercent))
  for (const phase of curve.phases) {
    if (p <= phase.until_progress) return phase
  }
  return curve.phases[curve.phases.length - 1]
}
