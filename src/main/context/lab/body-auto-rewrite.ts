/**
 * 正文生成后的自动去 AI 闭环：分段打分 → 高 AI 段落生成式重写 → 择优。
 *
 * 设计取舍：
 * - 打分与择优优先用真实困惑度（getSegmentMetrics，与检测器同源），直击困惑度信号
 *   （检测融合中困惑度占主导权重）。困惑度模型不可用时回退启发式，保证 always-on 可用。
 * - 重写用生成式（lab_deai 步骤，走 deai 高温组 + 频率惩罚）。
 * - 每段最多重写 N 个候选，按「改写幅度足够 + 数字锚点保留 + 困惑度分下降」择优；
 *   全部失败则保留原文，绝不因重写降质。
 */
import { appLogger } from '../../logger/app-logger'
import { modelService } from '../../model'
import { normalizeModelBodyOutput } from '../../../shared/normalize-body-text'
import { computeDocMetrics, computeHeuristicAiScore } from '../../perplexity/heuristic-detect'
import { getSegmentMetrics } from '../../perplexity'
import {
  computeChangeRatio,
  computeNumberAnchorRetention
} from './aigc-rewrite-quality'
import { formatBuiltinAntiAiRulesForPrompt } from '../anti-ai-rules'

/** 段落被判为「高 AI」需重写的分数门槛（困惑度优先，启发式回退） */
const REWRITE_SCORE_THRESHOLD = 60
/** 单段重写候选数（平衡质量与延迟） */
const CANDIDATES_PER_SEGMENT = 2
/** 单次自动重写最多处理的段落数，避免长章耗时失控 */
const MAX_SEGMENTS_TO_REWRITE = 6
/** 候选有效性的最小改写幅度 */
const MIN_CHANGE_RATIO = 0.1
/** 候选有效性的最小长度比（防止重写把段落写没） */
const MIN_LENGTH_RATIO = 0.5

const DEAI_SYSTEM_PROMPT = [
  '你是一个极其厌恶AI腔的网文作家。改写下面这段正文，消除机器写作痕迹。',
  '要求：保持原意、人物、情节走向与关键数字不变；改写句式节奏，掺入口语与具象细节；',
  '打破均匀句长与模板连接词；像赶稿的人类作者一样有精彩也有糙段。',
  '只输出改写后的正文，不要解释、不要加标题、不要用代码块。',
  formatBuiltinAntiAiRulesForPrompt()
].join('\n')

export interface AutoRewriteStats {
  totalSegments: number
  highAiSegments: number
  rewrittenSegments: number
  skipped: number
  originalScore: number
  finalScore: number
}

export interface AutoRewriteResult {
  content: string
  changed: boolean
  stats: AutoRewriteStats
}

/**
 * 按段落切分正文。
 * 本项目正文规范是段间单换行（normalize-body-text 会把 \n\n 压成 \n），
 * 因此按单换行切行；但网文有大量单行对话/碎片行，逐行打分噪声太大，
 * 故把连续短行合并成「逻辑段落」（累计到 ~120 字或遇到空行/「……」分隔断开），
 * 让每段是语义完整的叙事块，便于困惑度打分与重写。
 */
function splitParagraphs(text: string): string[] {
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return []

  const paragraphs: string[] = []
  let buffer = ''
  const flush = () => {
    const t = buffer.trim()
    if (t) paragraphs.push(t)
    buffer = ''
  }

  for (const line of lines) {
    // 「……」单独成行是场景分隔，强制断段
    if (/^[…·.]{2,}$/.test(line) || line === '……') {
      flush()
      continue
    }
    const merged = buffer ? buffer + line : line
    // 累计到一定字数后断段（避免单段过长，重写代价大）
    if (buffer && merged.replace(/\s/g, '').length > 120) {
      flush()
      buffer = line
    } else {
      buffer = merged
    }
  }
  flush()
  return paragraphs
}

/** 启发式打分：低分=更像人（困惑度模型不可用时的回退） */
function heuristicScore(text: string, docMetrics: ReturnType<typeof computeDocMetrics>): number {
  return computeHeuristicAiScore(text, docMetrics, 52)
}

interface RewriteCandidate {
  text: string
  score: number
}

/** 单段的困惑度三维度指标（与检测器同源） */
interface PplMetrics {
  aiScore: number
  ppl: number
  top5Rate: number
  avgProb: number
}

/**
 * 困惑度打分器：用与检测器同源的 getSegmentMetrics 给一组段落打真实困惑度。
 * 返回每段的完整三维度指标（PPL/Top5/AvgProb），供择优时针对 Top5 命中率
 * 与方向一致性优化——而非仅看综合 aiScore。
 * 失败（模型未就绪/退化）时返回 null，调用方回退启发式。
 */
async function perplexityMetrics(paragraphs: string[]): Promise<Map<number, PplMetrics> | null> {
  if (paragraphs.length === 0) return new Map()
  try {
    const joined = paragraphs.join('\n\n')
    const result = await getSegmentMetrics(joined)
    if (!result.segments || result.segments.length === 0) return null
    const map = new Map<number, PplMetrics>()
    const used = new Set<number>()
    for (let i = 0; i < paragraphs.length; i++) {
      const target = paragraphs[i].trim()
      let matchedIdx = -1
      for (let j = 0; j < result.segments.length; j++) {
        if (used.has(j)) continue
        if (result.segments[j].text.trim() === target || result.segments[j].text.includes(target)) {
          matchedIdx = j
          break
        }
      }
      if (matchedIdx >= 0) {
        used.add(matchedIdx)
        const s = result.segments[matchedIdx]
        map.set(i, { aiScore: s.aiScore, ppl: s.ppl, top5Rate: s.top5Rate, avgProb: s.avgProb })
      } else {
        map.set(i, { aiScore: result.docScore, ppl: 0, top5Rate: 0, avgProb: 0 })
      }
    }
    return map
  } catch (e) {
    appLogger.warn('body_auto_rewrite', '困惑度打分失败，回退启发式', {
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack?.split('\n').slice(0, 6).join(' | ') : undefined,
      cause: e instanceof Error && e.cause ? String(e.cause) : undefined
    })
    return null
  }
}

/**
 * 方向一致性度量（0=完全分散像人，1=三维度同向偏可预测=AI 特征）。
 * 检测器对 coherence 高的文本放大 AI 嫌疑，故择优应偏好 coherence 低的候选。
 */
function coherenceOf(m: PplMetrics): number {
  // PPL 高=创意方向（+），Top5 低=创意方向（+），AvgProb 低=创意方向（+）
  // 人类文本三维度符号不一致 → coherence 低
  const s1 = m.ppl > 17 ? 1 : -1
  const s2 = m.top5Rate < 0.5 ? 1 : -1
  const s3 = m.avgProb < 0.2 ? 1 : -1
  const positives = [s1, s2, s3].filter(s => s > 0).length
  const negatives = [s1, s2, s3].filter(s => s < 0).length
  return Math.max(positives, negatives) / 3
}

/** 对单段生成 N 个重写候选（headless，非流式） */
async function generateCandidates(
  segment: string,
  count: number
): Promise<string[]> {
  const candidates: string[] = []
  const prompt = `【原文段落】\n${segment}\n\n【改写要求】按系统提示改写这一段，输出改写后的正文。`
  for (let i = 0; i < count; i++) {
    try {
      const response = await modelService.chat(
        {
          prompt,
          systemPrompt: DEAI_SYSTEM_PROMPT,
          step: 'lab_deai',
          maxTokens: Math.max(800, segment.length * 2)
        },
        { stream: false }
      )
      if (response.success && response.content?.trim()) {
        const cleaned = normalizeModelBodyOutput(response.content.trim(), 'lab_deai')
        if (cleaned) candidates.push(cleaned)
      }
    } catch (e) {
      appLogger.warn('body_auto_rewrite', '候选生成失败', { index: i, error: String(e) })
    }
  }
  return candidates
}

/**
 * 在候选中择优。
 * 检测器对「三维度方向一致偏可预测」的文本放大 AI 嫌疑（coherenceMultiplier），
 * 且文档级 consistencyBoost 也由可疑段比例驱动。因此择优不再只看综合 aiScore，
 * 而是优先选能【降低 Top5 命中率 + 打破方向一致性】的候选——这才是人类文本
 * 「三维度散落」的本质特征。
 *
 * 有效候选（长度/改写幅度/数字锚点达标）按以下优先级排序：
 *  1. coherence 更低（方向更分散）——最关键
 *  2. Top5 命中率下降更多
 *  3. 综合 aiScore 更低
 * 仅当候选在 1 或 2 上比原文有改善时才采纳，否则保留原文。
 */
function pickBest(
  original: string,
  candidates: string[],
  originalMetrics: PplMetrics | null,
  candidateMetrics: (PplMetrics | null)[],
  docMetrics: ReturnType<typeof computeDocMetrics>
): RewriteCandidate | null {
  const minLen = Math.max(20, Math.floor(original.length * MIN_LENGTH_RATIO))
  const origTop5 = originalMetrics?.top5Rate ?? 1
  const origCoherence = originalMetrics ? coherenceOf(originalMetrics) : 1

  let best: { text: string; score: number; coherence: number; top5: number } | null = null

  for (let i = 0; i < candidates.length; i++) {
    const trimmed = candidates[i].trim()
    if (trimmed.length < minLen) continue

    const changeRatio = computeChangeRatio(original, trimmed)
    if (changeRatio < MIN_CHANGE_RATIO) continue

    const anchorRetention = computeNumberAnchorRetention(original, trimmed)
    if (anchorRetention < 0.8) continue

    const m = candidateMetrics[i]
    const score = m ? m.aiScore : heuristicScore(trimmed, docMetrics)
    const coherence = m ? coherenceOf(m) : origCoherence
    const top5 = m ? m.top5Rate : origTop5

    // 必须 Top5 下降或 coherence 下降才算改善（否则换汤不换药）
    const improves = m ? (top5 < origTop5 - 0.02 || coherence < origCoherence - 0.05) : false
    if (m && !improves) continue

    if (!best) {
      best = { text: trimmed, score, coherence, top5 }
      continue
    }
    // 排序键：coherence 升序 → top5 升序 → score 升序
    if (coherence < best.coherence ||
        (coherence === best.coherence && top5 < best.top5) ||
        (coherence === best.coherence && top5 === best.top5 && score < best.score)) {
      best = { text: trimmed, score, coherence, top5 }
    }
  }
  return best ? { text: best.text, score: best.score } : null
}

/**
 * 对生成正文执行自动去 AI 闭环。
 * 仅重写高 AI 段落，全部失败则原样返回。
 */
export async function autoRewriteBody(
  content: string,
  opts?: { maxSegments?: number }
): Promise<AutoRewriteResult> {
  const text = content.trim()
  if (!text) {
    return {
      content,
      changed: false,
      stats: { totalSegments: 0, highAiSegments: 0, rewrittenSegments: 0, skipped: 0, originalScore: 0, finalScore: 0 }
    }
  }

  const paragraphs = splitParagraphs(text)
  const docMetrics = computeDocMetrics(text)

  // 优先用真实困惑度打分；不可用则回退启发式
  const pplMap = await perplexityMetrics(paragraphs)
  const usePpl = pplMap !== null
  const metricsOf = (idx: number): PplMetrics | null =>
    usePpl && pplMap!.has(idx) ? pplMap!.get(idx)! : null
  const scoreOf = (idx: number): number => {
    const m = metricsOf(idx)
    return m ? m.aiScore : heuristicScore(paragraphs[idx], docMetrics)
  }

  const originalScore = paragraphs.length
    ? Math.round(paragraphs.reduce((s, _, idx) => s + scoreOf(idx), 0) / paragraphs.length)
    : 0

  // 标记需重写的段落（按分数倒序，只取最严重的若干段）
  const scored = paragraphs.map((p, idx) => ({ idx, p, score: scoreOf(idx) }))
  const toRewrite = scored
    .filter(s => s.score >= REWRITE_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts?.maxSegments ?? MAX_SEGMENTS_TO_REWRITE)

  appLogger.info('body_auto_rewrite', '开始自动重写', {
    segments: paragraphs.length,
    scoring: usePpl ? 'perplexity' : 'heuristic',
    highAi: toRewrite.length,
    originalScore
  })

  if (toRewrite.length === 0) {
    return {
      content,
      changed: false,
      stats: {
        totalSegments: paragraphs.length,
        highAiSegments: 0,
        rewrittenSegments: 0,
        skipped: 0,
        originalScore,
        finalScore: originalScore
      }
    }
  }

  let rewritten = 0
  let skipped = 0
  const replacement = new Map<number, string>()
  // 记录重写后候选的真实困惑度分，用于算 finalScore（修复 finalScore bug）
  const rewrittenScore = new Map<number, number>()

  for (const item of toRewrite) {
    const candidates = await generateCandidates(item.p, CANDIDATES_PER_SEGMENT)
    if (candidates.length === 0) {
      skipped++
      continue
    }
    // 候选也用困惑度打分；不可用则传 null 走启发式
    let candMetrics: (PplMetrics | null)[] | null = null
    if (usePpl) {
      const candPpl = await perplexityMetrics(candidates)
      if (candPpl) candMetrics = candidates.map((_, idx) => candPpl.get(idx) ?? null)
    }
    const origM = metricsOf(item.idx)
    const best = pickBest(item.p, candidates, origM, candMetrics ?? [], docMetrics)
    // 采纳条件：
    // - 困惑度模式：pickBest 已保证候选在 Top5/coherence 上有改善，直接采纳
    // - 启发式模式：要求综合分低于原段，避免无谓替换
    const accept = usePpl ? !!best : (!!best && best.score < item.score)
    if (accept) {
      replacement.set(item.idx, best!.text)
      rewrittenScore.set(item.idx, best!.score)
      rewritten++
    } else {
      skipped++
    }
  }

  if (rewritten === 0) {
    return {
      content,
      changed: false,
      stats: {
        totalSegments: paragraphs.length,
        highAiSegments: toRewrite.length,
        rewrittenSegments: 0,
        skipped,
        originalScore,
        finalScore: originalScore
      }
    }
  }

  // 重组：用双换行还原段落结构
  const finalParagraphs = paragraphs.map((p, idx) => replacement.get(idx) ?? p)
  const finalContent = finalParagraphs.join('\n\n')
  // finalScore：重写过的段用候选的真实困惑度分，未改段复用原分
  const finalScores = finalParagraphs.map((_, idx) =>
    rewrittenScore.has(idx) ? rewrittenScore.get(idx)! : scoreOf(idx)
  )
  const finalScore = Math.round(finalScores.reduce((a, b) => a + b, 0) / finalScores.length)

  appLogger.info('body_auto_rewrite', '自动去AI重写完成', {
    segments: paragraphs.length,
    scoring: usePpl ? 'perplexity' : 'heuristic',
    highAi: toRewrite.length,
    rewritten,
    skipped,
    originalScore,
    finalScore
  })

  return {
    content: finalContent,
    changed: true,
    stats: {
      totalSegments: paragraphs.length,
      highAiSegments: toRewrite.length,
      rewrittenSegments: rewritten,
      skipped,
      originalScore,
      finalScore
    }
  }
}
