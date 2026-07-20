import type { TokenMetric } from './api-perplexity'
import { splitStableSentences } from '../../shared/aigc-sentence-patches'

export const ZHUQUE_TOKEN_WINDOW_SIZE = 384
export const ZHUQUE_TOKEN_WINDOW_STRIDE = 192
export const ZHUQUE_MIN_TOKEN_WINDOW_SIZE = 128

export interface ZhuqueTextSpan {
  id: number
  start: number
  end: number
  text: string
}

export interface ZhuqueMetricSummary {
  ppl: number
  tokenCount: number
  top5Rate: number
  avgProb: number
}

export interface ZhuqueTokenWindow {
  startToken: number
  endToken: number
  start: number
  end: number
  metric: ZhuqueMetricSummary
  tokenMetrics?: TokenMetric[]
}

/**
 * 展示层只按完整句子切分，并完整保留原文的空白、换行和标点。
 * 计算窗口不会复用这些边界。
 */
export function splitZhuqueDisplaySentences(text: string): ZhuqueTextSpan[] {
  return splitStableSentences(text).map((unit, id) => ({
    id,
    start: unit.start,
    end: unit.end,
    text: unit.text
  }))
}

function summarize(metrics: TokenMetric[]): ZhuqueMetricSummary {
  if (metrics.length === 0) {
    return { ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 }
  }
  const meanLogProb = metrics.reduce((sum, metric) => sum + metric.logProb, 0) / metrics.length
  return {
    ppl: Math.exp(-meanLogProb),
    tokenCount: metrics.length,
    top5Rate: metrics.filter(metric => metric.inTop5).length / metrics.length,
    avgProb: metrics.reduce((sum, metric) => sum + metric.prob, 0) / metrics.length
  }
}

/** 以真实 tokenizer 输出建立 384-token、50% 重叠的计算窗口。 */
export function buildZhuqueTokenWindows(
  text: string,
  tokenMetrics: TokenMetric[],
  windowSize = ZHUQUE_TOKEN_WINDOW_SIZE,
  stride = ZHUQUE_TOKEN_WINDOW_STRIDE,
  minWindowSize = ZHUQUE_MIN_TOKEN_WINDOW_SIZE
): ZhuqueTokenWindow[] {
  if (tokenMetrics.length === 0) return []
  const ordered = [...tokenMetrics].sort((a, b) => a.charOffset - b.charOffset)
  const windows: ZhuqueTokenWindow[] = []

  for (let startToken = 0; startToken < ordered.length; startToken += stride) {
    const remaining = ordered.length - startToken
    if (windows.length > 0 && remaining < minWindowSize) {
      const anchoredStart = Math.max(0, ordered.length - windowSize)
      if (anchoredStart !== windows[windows.length - 1].startToken) {
        windows.push(createWindow(text, ordered, anchoredStart, ordered.length))
      }
      break
    }
    const endToken = Math.min(ordered.length, startToken + windowSize)
    windows.push(createWindow(text, ordered, startToken, endToken))
    if (endToken === ordered.length) break
  }
  return windows
}

function createWindow(
  text: string,
  metrics: TokenMetric[],
  startToken: number,
  endToken: number
): ZhuqueTokenWindow {
  const selected = metrics.slice(startToken, endToken)
  const first = selected[0]
  const last = selected[selected.length - 1]
  return {
    startToken,
    endToken,
    start: startToken === 0 ? 0 : first.charOffset,
    end: endToken === metrics.length
      ? text.length
      : Math.min(text.length, last.charOffset + Math.max(1, last.charLen)),
    metric: summarize(selected),
    tokenMetrics: selected
  }
}

/**
 * 从上下文窗口中只提取目标句自身的 token 指标。
 *
 * 同一 token 可能同时出现在两个重叠窗口中。优先采用目标 token 前置上下文更长的
 * 那个窗口，避免把同一个 token 重复计权，也不再把整窗其他句子的平均值灌给目标句。
 */
export function attributeTokenWindowsToSpans(
  spans: ZhuqueTextSpan[],
  windows: ZhuqueTokenWindow[]
): ZhuqueMetricSummary[] {
  return spans.map(span => {
    const selected = new Map<string, { metric: TokenMetric; contextLength: number }>()
    for (const window of windows) {
      for (const metric of window.tokenMetrics ?? []) {
        const tokenEnd = metric.charOffset + Math.max(1, metric.charLen)
        if (metric.charOffset >= span.end || tokenEnd <= span.start) continue
        const key = `${metric.charOffset}:${metric.charLen}`
        const contextLength = Math.max(0, metric.charOffset - window.start)
        const existing = selected.get(key)
        if (!existing || contextLength > existing.contextLength) {
          selected.set(key, { metric, contextLength })
        }
      }
    }
    return summarize([...selected.values()].map(item => item.metric))
  })
}
