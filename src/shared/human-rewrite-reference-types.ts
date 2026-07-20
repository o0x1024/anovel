export const HUMAN_REWRITE_SCENE_TYPES = [
  'dialogue',
  'action',
  'appearance',
  'environment',
  'psychology',
  'combat',
  'emotional_conflict',
  'exposition',
  'transition',
  'narration'
] as const

export type HumanRewriteSceneType = typeof HUMAN_REWRITE_SCENE_TYPES[number]

export const HUMAN_REWRITE_SCENE_LABELS: Record<HumanRewriteSceneType, string> = {
  dialogue: '人物对话',
  action: '人物动作',
  appearance: '外貌描写',
  environment: '环境描写',
  psychology: '心理活动',
  combat: '打斗追逐',
  emotional_conflict: '情感冲突',
  exposition: '信息揭示',
  transition: '场景过渡',
  narration: '叙述说明'
}

export const HUMAN_REWRITE_AI_SYMPTOMS = [
  'shot_chain',
  'written_connectors',
  'emotion_telling',
  'summary_closure',
  'immediate_causal_closure',
  'uniform_information',
  'regular_sentence_rhythm',
  'generic_voice',
  'over_explanation',
  'dialogue_template'
] as const

export type HumanRewriteAiSymptom = typeof HUMAN_REWRITE_AI_SYMPTOMS[number]

export const HUMAN_REWRITE_AI_SYMPTOM_LABELS: Record<HumanRewriteAiSymptom, string> = {
  shot_chain: '电影镜头链',
  written_connectors: '书面连接词',
  emotion_telling: '直接解释情绪',
  summary_closure: '总结收束',
  immediate_causal_closure: '因果即时闭合',
  uniform_information: '信息分布过匀',
  regular_sentence_rhythm: '句式节奏过齐',
  generic_voice: '人物声音通用化',
  over_explanation: '解释过度',
  dialogue_template: '模板化对话'
}

export interface HumanRewriteReferenceInput {
  title: string
  sceneTypes: HumanRewriteSceneType[]
  aiSymptoms: HumanRewriteAiSymptom[]
  originalText: string
  rewrittenText: string
  rewritePrinciples: string[]
  preservedFacts: string[]
  forbiddenChanges: string[]
  enabled?: boolean
  priority?: number
}

export interface HumanRewriteReference extends HumanRewriteReferenceInput {
  id: number
  enabled: boolean
  priority: number
  createTime: string
  updateTime: string
}

export interface HumanRewriteAssessment {
  sceneTypes: HumanRewriteSceneType[]
  aiSymptoms: HumanRewriteAiSymptom[]
  reason: string
}

export interface HumanRewritePlan extends HumanRewriteAssessment {
  references: HumanRewriteReference[]
}

