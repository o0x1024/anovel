import { appLogger } from '../../logger/app-logger'
import { getSegmentMetrics, type LabModelOverride } from '../../perplexity'

export interface RewriteCandidateInput {
  key: string
  text: string
}

export interface RewriteCandidateEvaluation {
  key: string
  text: string
  docScore: number
  changeRatio: number
  numberAnchorRetention: number
  objectiveScore: number
  issues: string[]
  valid: boolean
}

export interface RewriteSelection {
  selected: RewriteCandidateEvaluation
  evaluations: RewriteCandidateEvaluation[]
}

const MIN_CHANGE_RATIO = 0.08
const MIN_NUMBER_ANCHOR_RETENTION = 0.8
const MIN_LENGTH_RATIO = 0.35

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 使用 bigram 集合交集衡量改写幅度，避免单字符位移误判。
 */
export function computeChangeRatio(source: string, target: string): number {
  const a = source.replace(/\s+/g, '')
  const b = target.replace(/\s+/g, '')
  if (!a && !b) return 0
  if (!a || !b) return 1

  const bigramsA = new Set<string>()
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a[i] + a[i + 1])
  let shared = 0
  const totalB = Math.max(1, b.length - 1)
  for (let i = 0; i < b.length - 1; i++) {
    if (bigramsA.has(b[i] + b[i + 1])) shared++
  }
  const overlapRatio = shared / Math.max(bigramsA.size, totalB)
  return clamp(1 - overlapRatio, 0, 1)
}

function countNumberAnchors(text: string): Map<string, number> {
  const map = new Map<string, number>()
  const matches = text.match(/\d+(?:\.\d+)?/g) || []
  for (const token of matches) {
    map.set(token, (map.get(token) || 0) + 1)
  }
  return map
}

export function computeNumberAnchorRetention(source: string, target: string): number {
  const sourceMap = countNumberAnchors(source)
  if (sourceMap.size === 0) return 1
  const targetMap = countNumberAnchors(target)
  let total = 0
  let kept = 0
  for (const [token, sourceCount] of sourceMap.entries()) {
    total += sourceCount
    kept += Math.min(sourceCount, targetMap.get(token) || 0)
  }
  if (total <= 0) return 1
  return kept / total
}

function dedupeCandidates(candidates: RewriteCandidateInput[]): RewriteCandidateInput[] {
  const seen = new Set<string>()
  const unique: RewriteCandidateInput[] = []
  for (const candidate of candidates) {
    const text = candidate.text.trim()
    if (!text) continue
    if (seen.has(text)) continue
    seen.add(text)
    unique.push({ key: candidate.key, text })
  }
  return unique
}

export async function evaluateRewriteCandidates(params: {
  runId: string
  originalText: string
  candidates: RewriteCandidateInput[]
  baselineDocScore?: number
  labModel?: LabModelOverride
  evaluateWithMetrics?: boolean
  onProgress?: (msg: string) => void
}): Promise<RewriteSelection> {
  const { runId, originalText, baselineDocScore, labModel, onProgress } = params
  const evaluateWithMetrics = params.evaluateWithMetrics !== false
  const candidates = dedupeCandidates(params.candidates)
  if (candidates.length === 0) {
    throw new Error('没有可用的改写候选文本')
  }

  const minExpectedLength = Math.max(50, Math.floor(originalText.length * MIN_LENGTH_RATIO))
  const evaluations: RewriteCandidateEvaluation[] = []

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    onProgress?.(`正在校验候选 ${i + 1}/${candidates.length}（${candidate.key}）…`)
    const text = candidate.text.trim()
    const issues: string[] = []

    if (text.length < minExpectedLength) {
      issues.push(`长度过短(${text.length}/${minExpectedLength})`)
    }

    const changeRatio = computeChangeRatio(originalText, text)
    if (changeRatio < MIN_CHANGE_RATIO) {
      issues.push(`改写幅度不足(${Math.round(changeRatio * 100)}%)`)
    }

    const numberAnchorRetention = computeNumberAnchorRetention(originalText, text)
    if (numberAnchorRetention < MIN_NUMBER_ANCHOR_RETENTION) {
      issues.push(`数字锚点保留不足(${Math.round(numberAnchorRetention * 100)}%)`)
    }

    let docScore = typeof baselineDocScore === 'number' ? baselineDocScore : 50
    if (evaluateWithMetrics) {
      try {
        const metrics = await getSegmentMetrics(text, undefined, labModel)
        docScore = metrics.docScore
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        issues.push(`困惑度复检失败(${message})`)
      }
    }

    let objectiveScore = docScore
    if (typeof baselineDocScore === 'number') {
      const delta = docScore - baselineDocScore
      if (delta > 0) objectiveScore += delta * 0.8
    }
    if (changeRatio < 0.12) objectiveScore += (0.12 - changeRatio) * 60
    if (numberAnchorRetention < 0.95) objectiveScore += (0.95 - numberAnchorRetention) * 40
    if (issues.length > 0) objectiveScore += 10

    evaluations.push({
      key: candidate.key,
      text,
      docScore: Math.round(docScore * 10) / 10,
      changeRatio: Math.round(changeRatio * 1000) / 1000,
      numberAnchorRetention: Math.round(numberAnchorRetention * 1000) / 1000,
      objectiveScore: Math.round(objectiveScore * 10) / 10,
      issues,
      valid: issues.length === 0
    })
  }

  evaluations.sort((a, b) => a.objectiveScore - b.objectiveScore)
  const selected = evaluations.find(item => item.valid) || evaluations[0]

  appLogger.info('aigc-rewrite', {
    runId,
    stage: 'candidate-selection',
    baselineDocScore: typeof baselineDocScore === 'number' ? Math.round(baselineDocScore * 10) / 10 : null,
    selected: {
      key: selected.key,
      docScore: selected.docScore,
      changeRatio: selected.changeRatio,
      numberAnchorRetention: selected.numberAnchorRetention,
      objectiveScore: selected.objectiveScore,
      issues: selected.issues
    },
    candidates: evaluations.map(item => ({
      key: item.key,
      docScore: item.docScore,
      changeRatio: item.changeRatio,
      numberAnchorRetention: item.numberAnchorRetention,
      objectiveScore: item.objectiveScore,
      issues: item.issues
    }))
  })

  return {
    selected,
    evaluations
  }
}
