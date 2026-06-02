import { writingStyleDAO } from '../../db'
import {
  formatBuiltinAntiAiRulesForPrompt,
  buildStyleFewShotForStyle
} from '../anti-ai-rules'
import { formatStepRulesForLayers } from '../style-step-rules'
import { parseStyleStepRules } from '../../../shared/style-step-rules'
import { BODY_PARAGRAPH_SPACING_RULE } from '../../../shared/normalize-body-text'
import { resolvePrompt } from '../prompt-registry'

const LAB_DEAI_INSTRUCTION = [
  '你是一个极其厌恶AI的网文作家。',
  '',
  '排版：' + BODY_PARAGRAPH_SPACING_RULE,
  ''
].join('\n')

/**
 * AI 实验室去 AI：按文风 ID 组装完整 system prompt（不依赖作品 workId）。
 * 对齐稿件优化 buildStyleRewriteSystemPrompt 的文风覆盖范围。
 */
export function buildLabDeaiSystemPrompt(styleId: number): string {
  const style = writingStyleDAO.getById(styleId)
  if (!style) throw new Error('所选文风不存在')

  const labBase = resolvePrompt('lab_deai.system')
  const instruction = labBase
    ? [labBase, '', '排版：' + BODY_PARAGRAPH_SPACING_RULE, ''].join('\n')
    : LAB_DEAI_INSTRUCTION
  const parts: string[] = [instruction]

  if (style.description?.trim()) {
    parts.push(`【文风说明 · ${style.name}】\n${style.description.trim()}`)
  }

  if (style.prompt_template?.trim()) {
    parts.push(style.prompt_template.trim())
  }

  const stepRules = parseStyleStepRules(style.step_rules_json)
  if (stepRules) {
    const stepBlock = formatStepRulesForLayers(stepRules, ['identity', 'checklist'])
    if (stepBlock) parts.push(stepBlock)
  }

  const fewShot = buildStyleFewShotForStyle(styleId)
  if (fewShot) parts.push(fewShot)

  const antiAi = formatBuiltinAntiAiRulesForPrompt()
  if (antiAi) parts.push(antiAi)

  return parts.join('\n\n')
}
