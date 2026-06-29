import { countWords } from './body-word-target'

export interface PreviewAnchorCandidate {
  paragraphIndex: number
  charIndex: number
  wordCount: number
  ratio: number
  paragraphText: string
  score: number
  reason: string
}

export interface PreviewAnchorOptions {
  tolerance?: number
  topK?: number
}

const HOOK_PATTERNS: { pattern: RegExp; score: number; reason: string }[] = [
  { pattern: /[？\?]\s*$/, score: 35, reason: '以疑问结尾，激发好奇' },
  { pattern: /[！!]\s*$/, score: 25, reason: '情绪爆发，悬念感强' },
  { pattern: /(?:没想到|竟然|居然|谁知|岂料|不料|原来|真相|秘密|暴露|发现|揭开)\s*[。！？\n]?/i, score: 30, reason: '含真相/反转类钩子词' },
  { pattern: /(?:突然|猛地|骤然|刹那间|瞬间|忽然|霎时)\s*[。！？\n]?/i, score: 25, reason: '突发转折，节奏骤变' },
  { pattern: /(?:难道|究竟|为何|怎么|凭什么|怎么可能)\s*[。！？\n]?/i, score: 25, reason: '设问式钩子' },
  { pattern: /(?:死|杀|血|刀|枪|死|活|背叛|离婚|分手|怀孕|流产|入狱|破产|灭门|重生|穿越)\s*[。！？\n]?/i, score: 20, reason: '含强冲突/高情绪事件词' },
  { pattern: /(?:但是|可是|然而|不过|却|偏偏|只是|岂料|反倒)\s*[。！？\n]?/i, score: 15, reason: '转折关系，制造落差' }
]

const DEFAULT_TOLERANCE = 0.1
const DEFAULT_TOP_K = 3

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(p => p.trim())
    .filter(p => p.length > 0)
}

function scoreParagraph(paragraph: string): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []
  for (const { pattern, score: s, reason } of HOOK_PATTERNS) {
    if (pattern.test(paragraph)) {
      score += s
      if (!reasons.includes(reason)) reasons.push(reason)
    }
  }
  return { score, reasons }
}

function clampRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0.3
  return Math.max(0.05, Math.min(0.95, ratio))
}

export function findPreviewAnchorCandidates(
  text: string,
  ratio: number,
  options: PreviewAnchorOptions = {}
): PreviewAnchorCandidate[] {
  const paragraphs = splitParagraphs(text)
  if (paragraphs.length === 0) return []

  const totalWords = countWords(text)
  if (totalWords === 0) return []

  const targetRatio = clampRatio(ratio)
  const targetWords = Math.round(totalWords * targetRatio)
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE
  const topK = options.topK ?? DEFAULT_TOP_K

  const minWords = Math.max(0, Math.floor(targetWords * (1 - tolerance)))
  const maxWords = Math.ceil(targetWords * (1 + tolerance))

  const candidates: PreviewAnchorCandidate[] = []
  let cumulativeWords = 0
  let charIndex = 0

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i]
    const paragraphWords = countWords(paragraph)
    const nextCumulativeWords = cumulativeWords + paragraphWords
    const nextCharIndex = charIndex + paragraph.length + (i < paragraphs.length - 1 ? 1 : 0)

    if (nextCumulativeWords >= minWords && nextCumulativeWords <= maxWords) {
      const { score, reasons } = scoreParagraph(paragraph)
      const positionScore = 1 - Math.abs(nextCumulativeWords - targetWords) / Math.max(1, targetWords)
      const finalScore = score + positionScore * 15

      candidates.push({
        paragraphIndex: i,
        charIndex: nextCharIndex,
        wordCount: nextCumulativeWords,
        ratio: nextCumulativeWords / totalWords,
        paragraphText: paragraph,
        score: Math.round(finalScore * 10) / 10,
        reason: reasons.length > 0 ? reasons.join('；') : '落在目标比例附近'
      })
    }

    cumulativeWords = nextCumulativeWords
    charIndex = nextCharIndex
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, topK)
}

export function suggestPreviewAnchor(
  text: string,
  ratio: number,
  options: PreviewAnchorOptions = {}
): PreviewAnchorCandidate | null {
  const candidates = findPreviewAnchorCandidates(text, ratio, { ...options, topK: 1 })
  return candidates[0] ?? null
}

export function formatPreviewAnchorReport(
  text: string,
  ratio: number,
  options: PreviewAnchorOptions = {}
): string {
  const candidates = findPreviewAnchorCandidates(text, ratio, options)
  if (candidates.length === 0) {
    return '未找到合适的试读卡点，请检查正文是否为空。'
  }

  const totalWords = countWords(text)
  const lines: string[] = [
    `总字数：${totalWords} 字`,
    `目标试读比例：${Math.round(ratio * 100)}%（约 ${Math.round(totalWords * ratio)} 字）`,
    `推荐候选点（按钩子强度排序）：`,
    ''
  ]

  candidates.forEach((c, idx) => {
    lines.push(`候选 ${idx + 1}：第 ${c.paragraphIndex + 1} 段末 · ${c.wordCount} 字（${Math.round(c.ratio * 100)}%）`)
    lines.push(`评分：${c.score}`)
    lines.push(`理由：${c.reason}`)
    lines.push(`段落内容：${c.paragraphText}`)
    lines.push('')
  })

  return lines.join('\n')
}
