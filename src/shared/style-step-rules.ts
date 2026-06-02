/** 文风分步规则：按创作步骤注入不同层级的约束 */
export interface StyleStepRules {
  identity: {
    emotional_core: string[]
    target_reader: string
    style_keywords: string[]
  }
  decision_rules: string[]
  pacing_rules: {
    conflict_interval: string
    payoff_interval: string
    chapter_end_must: string[]
    emotion_loop: string[]
  }
  quality_checklist: string[]
}

export function parseStyleStepRules(json: string | null | undefined): StyleStepRules | null {
  if (!json?.trim()) return null
  try {
    const parsed = JSON.parse(json) as StyleStepRules
    if (!parsed?.identity) return null
    return {
      identity: {
        emotional_core: parsed.identity.emotional_core ?? [],
        target_reader: parsed.identity.target_reader ?? '',
        style_keywords: parsed.identity.style_keywords ?? []
      },
      decision_rules: parsed.decision_rules ?? [],
      pacing_rules: {
        conflict_interval: parsed.pacing_rules?.conflict_interval ?? '',
        payoff_interval: parsed.pacing_rules?.payoff_interval ?? '',
        chapter_end_must: parsed.pacing_rules?.chapter_end_must ?? [],
        emotion_loop: parsed.pacing_rules?.emotion_loop ?? []
      },
      quality_checklist: parsed.quality_checklist ?? []
    }
  } catch {
    return null
  }
}

export function emptyStyleStepRules(): StyleStepRules {
  return {
    identity: { emotional_core: [], target_reader: '', style_keywords: [] },
    decision_rules: [],
    pacing_rules: {
      conflict_interval: '',
      payoff_interval: '',
      chapter_end_must: [],
      emotion_loop: []
    },
    quality_checklist: []
  }
}
