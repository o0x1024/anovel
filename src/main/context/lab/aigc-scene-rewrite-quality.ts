import { splitStableSentences } from '../../../shared/aigc-sentence-patches'
import { computeChangeRatio } from './aigc-rewrite-quality'
import type { AigcDistribution } from '../../../shared/aigc-detect-types'

const QUOTED_DIALOGUE = /[“「『"]([^”」』"\n]*)[”」』"]/g
const VALID_TERMINAL = /[。！？!?…][”」』"'）)】\]]*$/
const DANGLING_TERMINAL = /[，、,：:]$/
const HAN_SEQUENCE = /[\u3400-\u9fff]+/g

export function requiresFullDocumentSceneRewrite(distribution: AigcDistribution): boolean {
  return distribution.suspected_ai + distribution.ai > distribution.human
}

function narrativeText(text: string): string {
  return text.replace(QUOTED_DIALOGUE, '').replace(/\s+/g, '')
}

export function computeNarrativeChangeRatio(source: string, target: string): number {
  return computeChangeRatio(narrativeText(source), narrativeText(target))
}

function paragraphTerminalIssues(text: string): string[] {
  const issues: string[] = []
  const paragraphs = text.split(/\n+/).map(item => item.trim()).filter(Boolean)
  paragraphs.forEach((paragraph, index) => {
    if (DANGLING_TERMINAL.test(paragraph)) {
      issues.push(`第${index + 1}段以逗号或冒号悬空结束`)
    } else if (!VALID_TERMINAL.test(paragraph)) {
      issues.push(`第${index + 1}段缺少完整句末标点`)
    }
  })
  return issues
}

function maximumSentenceLength(text: string): number {
  return splitStableSentences(text).reduce(
    (maximum, unit) => Math.max(maximum, unit.text.replace(/\s+/g, '').length),
    0
  )
}

function repeatedHanGrams(text: string, size = 4): Map<string, number> {
  const counts = new Map<string, number>()
  for (const sequence of narrativeText(text).match(HAN_SEQUENCE) ?? []) {
    for (let index = 0; index + size <= sequence.length; index++) {
      const gram = sequence.slice(index, index + size)
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
  }
  return counts
}

function findIntroducedRepeatedPhrase(source: string, target: string): string | undefined {
  const sourceCounts = repeatedHanGrams(source)
  const targetCounts = repeatedHanGrams(target)
  for (const [phrase, count] of targetCounts) {
    if (count >= 2 && count > (sourceCounts.get(phrase) ?? 0)) return phrase
  }
  return undefined
}

function hasBalancedQuotes(text: string): boolean {
  return (text.match(/“/g)?.length ?? 0) === (text.match(/”/g)?.length ?? 0) &&
    (text.match(/「/g)?.length ?? 0) === (text.match(/」/g)?.length ?? 0) &&
    (text.match(/『/g)?.length ?? 0) === (text.match(/』/g)?.length ?? 0)
}

export function findSceneRewriteProseIssues(source: string, target: string): string[] {
  const issues = paragraphTerminalIssues(target)
  if (!hasBalancedQuotes(target)) issues.push('引号不成对')
  if (/(?:[，,]{2,}|[，,][。！？!?]|[。！？!?][，,])/.test(target)) issues.push('存在连续冲突标点')

  const sourceMaximum = maximumSentenceLength(source)
  const targetMaximum = maximumSentenceLength(target)
  const allowedMaximum = Math.max(120, Math.ceil(sourceMaximum * 1.2))
  if (targetMaximum > allowedMaximum) {
    issues.push(`最长句${targetMaximum}字，超过该语义块允许的${allowedMaximum}字`)
  }

  const repeated = findIntroducedRepeatedPhrase(source, target)
  if (repeated) issues.push(`新增重复短语“${repeated}”`)
  return Array.from(new Set(issues))
}

export function computePassedRewriteCoverage(
  targetTexts: readonly string[],
  passedTexts: readonly string[]
): number {
  const length = (text: string) => Math.max(1, text.replace(/\s+/g, '').length)
  const targetLength = targetTexts.reduce((sum, text) => sum + length(text), 0)
  const passedLength = passedTexts.reduce((sum, text) => sum + length(text), 0)
  return targetLength > 0 ? passedLength / targetLength : 1
}
