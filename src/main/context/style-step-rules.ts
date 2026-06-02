import type { StyleStepRules } from '../../shared/style-step-rules'
import { parseStyleStepRules } from '../../shared/style-step-rules'

export type StyleStepLayer = 'identity' | 'decision' | 'pacing' | 'language' | 'checklist'

export interface StepStyleInjection {
  /** 语言层：正文生成用 prompt_template */
  languageText: string | null
  /** 分步规则层：大纲/设定等阶段 */
  stepRulesText: string | null
  layers: StyleStepLayer[]
}

function matchStepPrefix(step: string | undefined, prefixes: string[]): boolean {
  if (!step) return false
  return prefixes.some(p => step === p || step.startsWith(`${p}_`) || step.startsWith(p))
}

/** 作品管理 · 核心设定三项的「AI 生成」步骤（非修订/自检） */
export function isCoreSettingsAiGenerateStep(step: string | undefined): boolean {
  if (!step) return false
  return /^settings_(character|worldview|conflict|idea)$/.test(step)
}

export function resolveLayersForStep(step: string | undefined): StyleStepLayer[] {
  if (!step) return ['language']

  if (matchStepPrefix(step, ['body'])) {
    return ['language', 'decision', 'pacing']
  }
  if (
    matchStepPrefix(step, [
      'quality',
      'critique',
      'revision',
      'anti_mean',
      'settings_overall_check',
      'settings_character_check'
    ]) ||
    step?.endsWith('_self_check')
  ) {
    return ['checklist', 'identity']
  }
  if (matchStepPrefix(step, ['assistant'])) {
    return ['identity', 'checklist']
  }
  if (matchStepPrefix(step, ['incubator'])) {
    return ['identity']
  }
  if (isCoreSettingsAiGenerateStep(step)) {
    return ['identity']
  }
  if (matchStepPrefix(step, ['settings'])) {
    return ['identity', 'decision']
  }
  if (matchStepPrefix(step, ['volumes'])) {
    return ['identity', 'pacing']
  }
  if (matchStepPrefix(step, ['volume_chapters', 'chapter_outline', 'chapter_abc'])) {
    return ['decision', 'pacing']
  }

  if (step === 'lab_deai') {
    return ['language', 'identity', 'checklist']
  }

  return ['identity', 'decision']
}

function formatIdentity(rules: StyleStepRules): string {
  const lines = ['【文风身份 - 贯穿创作方向】']
  if (rules.identity.emotional_core.length) {
    lines.push(`- 核心情绪价值：${rules.identity.emotional_core.join('、')}`)
  }
  if (rules.identity.target_reader) {
    lines.push(`- 目标读者：${rules.identity.target_reader}`)
  }
  if (rules.identity.style_keywords.length) {
    lines.push(`- 风格关键词：${rules.identity.style_keywords.join('、')}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

function formatDecisionRules(rules: StyleStepRules): string {
  if (!rules.decision_rules.length) return ''
  return ''
  // return [
  //   '【文风决策规则 - 生成时须逐条对照】',
  //   ...rules.decision_rules.map(r => `- ${r}`)
  // ].join('\n')
}

/** 将决策规则转为场景级决策树（LLM 更易执行） */
export function formatSceneDecisionTree(rules: StyleStepRules): string {
  if (!rules.decision_rules.length) return ''
  const steps = rules.decision_rules.map((rule, i) => {
    const normalized = rule.replace(/^(IF|当)\s+/i, '').trim()
    const parts = normalized.split(/\s*→\s*/)
    if (parts.length >= 2) {
      return `${i + 1}. ${parts[0].trim()}？\n   → ${parts.slice(1).join(' → ')}`
    }
    return `${i + 1}. ${normalized}`
  })
  return ''
  // return [
  //   '【场景写作决策树 - 每场景开始前执行】',
  //   'START SCENE',
  //   ...steps,
  //   'END SCENE'
  // ].join('\n')
}

function formatPacingRules(rules: StyleStepRules): string {
  const pr = rules.pacing_rules
  const lines = ['【节奏约束】']
  if (pr.conflict_interval) lines.push(`- 冲突间隔：${pr.conflict_interval}`)
  if (pr.payoff_interval) lines.push(`- 爽点/回报间隔：${pr.payoff_interval}`)
  if (pr.chapter_end_must.length) {
    lines.push(`- 章末必须包含：${pr.chapter_end_must.join(' / ')}`)
  }
  if (pr.emotion_loop.length) {
    lines.push(`- 情绪循环：${pr.emotion_loop.join(' → ')}`)
  }
  return ''
  // return lines.length > 1 ? lines.join('\n') : ''
}

function formatChecklist(rules: StyleStepRules): string {
  if (!rules.quality_checklist.length) return ''
  return [
    '【文风质量检查清单 - 自检时逐条勾选】',
    ...rules.quality_checklist.map(item => `□ ${item}`)
  ].join('\n')
}

export function formatStepRulesForLayers(
  rules: StyleStepRules,
  layers: StyleStepLayer[]
): string {
  const parts: string[] = []
  if (layers.includes('identity')) {
    const t = formatIdentity(rules)
    if (t) parts.push(t)
  }
  if (layers.includes('decision')) {
    const t = formatDecisionRules(rules)
    if (t) parts.push(t)
    const tree = formatSceneDecisionTree(rules)
    if (tree) parts.push(tree)
  }
  if (layers.includes('pacing')) {
    const t = formatPacingRules(rules)
    if (t) parts.push(t)
  }
  if (layers.includes('checklist')) {
    const t = formatChecklist(rules)
    if (t) parts.push(t)
  }
  return parts.join('\n\n')
}

export function resolveStepStyleInjection(
  step: string | undefined,
  promptTemplate: string,
  stepRulesJson: string | null | undefined
): StepStyleInjection {
  const layers = resolveLayersForStep(step)
  const rules = parseStyleStepRules(stepRulesJson)
  const isBody = layers.includes('language')

  if (!rules) {
    return {
      languageText: isBody && promptTemplate.trim() ? promptTemplate : null,
      stepRulesText: !isBody && promptTemplate.trim() ? promptTemplate : null,
      layers: isBody ? ['language'] : []
    }
  }

  const nonLanguageLayers = layers.filter(l => l !== 'language')
  const stepRulesText = nonLanguageLayers.length
    ? formatStepRulesForLayers(rules, nonLanguageLayers)
    : null

  return {
    languageText: isBody && promptTemplate.trim() ? promptTemplate : null,
    stepRulesText: stepRulesText || null,
    layers
  }
}
