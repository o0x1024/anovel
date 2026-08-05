export const CAUSAL_STEP_EXECUTION_PROFILE = {
  candidateGeneration: {
    temperature: 0.45,
    maxTokens: 3600,
    forceThinkingDisabled: true
  },
  candidateScoring: {
    temperature: 0,
    maxTokens: 2200,
    forceThinkingDisabled: true
  },
  decisionMaterialization: {
    temperature: 0.25,
    maxTokens: 4200,
    forceThinkingDisabled: true
  },
  decisionAudit: {
    temperature: 0,
    maxTokens: 1800,
    forceThinkingDisabled: true
  }
} as const
