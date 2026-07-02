import { normalizeBodyParagraphSpacing } from '../../shared/normalize-body-text'
import { aigcWordtableDAO } from '../db'
import { applyWordTable } from './lab/aigc-wordtable-engine'

/**
 * 后处理人性化模块
 * 仅应用用户在「AI实验室 → 词表替换」中配置的规则。
 */

export interface HumanizeOptions {
  referenceText?: string
}

/**
 * 对 AI 生成文本进行人性化后处理。
 * 仅应用用户词表替换规则，不做其他内置扰动。
 */
export function humanizeText(text: string, _options: HumanizeOptions = {}): string {
  if (!text.trim()) return text

  let result = text

  const userEntries = aigcWordtableDAO.listEnabled()
  if (userEntries.length > 0) {
    result = applyWordTable(result, userEntries)
  }

  return normalizeBodyParagraphSpacing(result)
}

/**
 * 统计文本的"AI味"指标，用于 UI 展示。
 */
export function measureAiSignature(text: string): {
  wordSubstitutionHits: number
  uniformSentenceRuns: number
  avgTokenPredictability: string
} {
  const AI_WORDS = [
    /微微/g, /缓缓/g, /静静/g, /默默/g, /不禁/g, /凝视/g, /注视/g,
    /目光/g, /端详/g, /驻足/g, /伫立/g, /踱步/g, /深邃/g, /温柔/g,
    /仿佛/g, /宛如/g, /犹如/g, /如同/g, /随即/g, /旋即/g, /竟然/g,
  ]

  let hits = 0
  for (const pattern of AI_WORDS) {
    hits += (text.match(pattern) ?? []).length
  }

  const sentences = text.split(/[。！？]+/).filter(s => s.trim().length > 0)
  let uniformRuns = 0
  let runLength = 1
  for (let i = 1; i < sentences.length; i++) {
    const curr = sentences[i].replace(/\s/g, '').length
    const prev = sentences[i - 1].replace(/\s/g, '').length
    if (Math.abs(curr - prev) < Math.max(curr, prev) * 0.25) {
      runLength++
    } else {
      if (runLength >= 3) uniformRuns++
      runLength = 1
    }
  }
  if (runLength >= 3) uniformRuns++

  return {
    wordSubstitutionHits: hits,
    uniformSentenceRuns: uniformRuns,
    avgTokenPredictability: hits > 15 ? '高' : hits > 8 ? '中' : '低'
  }
}
