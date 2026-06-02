export interface StyleFingerprint {
  avgSentenceLength: number
  sentenceLengthCategory: 'short' | 'medium' | 'long'
  /** 句长变异系数（标准差/均值），衡量 burstiness；人类写作通常 > 0.6 */
  sentenceLengthCV: number
  /** ≤6字碎片短句占比 */
  shortSentenceRatio: number
  dialogueDensity: number
  avgParagraphLength: number
  connectorDensity: number
  exclamationDensity: number
  /** 比喻/修辞密度（处/500字） */
  metaphorDensityPer500: number
  wordCount: number
}

const METAPHOR_RES = [
  /像[^。！？\n]{2,20}(?:一样|似的|般)/g,
  /如同[^。！？\n]{2,20}/g,
  /仿佛[^。！？\n]{2,20}/g,
  /宛如[^。！？\n]{2,20}/g,
  /好似[^。！？\n]{2,20}/g,
  /犹如[^。！？\n]{2,20}/g,
  /像是[^。！？\n]{2,20}/g
]

function countMetaphorsInText(text: string): number {
  let n = 0
  for (const re of METAPHOR_RES) n += (text.match(re) ?? []).length
  return n
}

export function extractStyleFingerprint(text: string): StyleFingerprint {
  const trimmed = text.trim()
  if (!trimmed) {
    return {
      avgSentenceLength: 0,
      sentenceLengthCategory: 'medium',
      sentenceLengthCV: 0,
      shortSentenceRatio: 0,
      dialogueDensity: 0,
      avgParagraphLength: 0,
      connectorDensity: 0,
      exclamationDensity: 0,
      metaphorDensityPer500: 0,
      wordCount: 0
    }
  }

  const sentences = trimmed.split(/[。！？!?…]+/).filter(s => s.trim().length > 0)
  const sentenceLengths = sentences.map(s => s.replace(/\s/g, '').length)
  const avgSentenceLength = sentenceLengths.length
    ? Math.round(sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length)
    : 0

  let sentenceLengthCV = 0
  let shortSentenceRatio = 0
  if (sentenceLengths.length >= 3 && avgSentenceLength > 0) {
    const variance = sentenceLengths.reduce((s, l) => s + Math.pow(l - avgSentenceLength, 2), 0) / sentenceLengths.length
    sentenceLengthCV = Math.round((Math.sqrt(variance) / avgSentenceLength) * 100) / 100
    shortSentenceRatio = Math.round((sentenceLengths.filter(l => l <= 6).length / sentenceLengths.length) * 100) / 100
  }

  let sentenceLengthCategory: StyleFingerprint['sentenceLengthCategory'] = 'medium'
  if (avgSentenceLength <= 25) sentenceLengthCategory = 'short'
  else if (avgSentenceLength >= 40) sentenceLengthCategory = 'long'

  const dialogueMatches = trimmed.match(/[「""][^」""]*[」""]|"[^"]*"/g) ?? []
  const dialogueChars = dialogueMatches.join('').replace(/\s/g, '').length
  const totalChars = trimmed.replace(/\s/g, '').length
  const dialogueDensity = totalChars > 0 ? Math.round((dialogueChars / totalChars) * 100) : 0

  const paragraphs = trimmed.split(/\n\n+/).filter(p => p.trim())
  const avgParagraphLength = paragraphs.length
    ? Math.round(paragraphs.reduce((s, p) => s + p.replace(/\s/g, '').length, 0) / paragraphs.length)
    : totalChars

  const connectors = ['然而', '因此', '总的来说', '与此同时', '不仅如此', '此外', '不过', '于是']
  let connectorCount = 0
  for (const c of connectors) {
    connectorCount += (trimmed.match(new RegExp(c, 'g')) ?? []).length
  }
  const connectorDensity = totalChars > 0
    ? Math.round((connectorCount / (totalChars / 1000)) * 10) / 10
    : 0

  const exclamationDensity = totalChars > 0
    ? Math.round(((trimmed.match(/[！!]/g) ?? []).length / (totalChars / 1000)) * 10) / 10
    : 0

  const metaphorCount = countMetaphorsInText(trimmed)
  const metaphorDensityPer500 = totalChars > 0
    ? Math.round((metaphorCount / (totalChars / 500)) * 10) / 10
    : 0

  return {
    avgSentenceLength,
    sentenceLengthCategory,
    sentenceLengthCV,
    shortSentenceRatio,
    dialogueDensity,
    avgParagraphLength,
    connectorDensity,
    exclamationDensity,
    metaphorDensityPer500,
    wordCount: totalChars
  }
}

export function fingerprintToPrompt(fp: StyleFingerprint): string {
  const labels = { short: '短句型', medium: '中等句长', long: '长句型' }
  const lines = [
    '【文风指纹约束】',
    `- 平均句长约 ${fp.avgSentenceLength} 字（${labels[fp.sentenceLengthCategory]}）`,
    `- 对话密度约 ${fp.dialogueDensity}%`,
    `- 典型段落长度约 ${fp.avgParagraphLength} 字`,
    `- 连接词密度约 ${fp.connectorDensity}/千字`
  ]
  if (fp.sentenceLengthCV > 0) {
    lines.push(`- 句长变异系数约 ${fp.sentenceLengthCV}（值越高=句长越参差不齐，人类写作通常 0.6-1.0）`)
  }
  if (fp.shortSentenceRatio > 0) {
    lines.push(`- 碎片短句（≤6字）占比约 ${Math.round(fp.shortSentenceRatio * 100)}%`)
  }
  if (fp.metaphorDensityPer500 !== undefined) {
    lines.push(`- 修辞/比喻密度约 ${fp.metaphorDensityPer500} 处/500字`)
  }
  lines.push('生成时请尽量匹配以上量化特征，特别注意句长变异系数——不要让句子长度过于均匀。')
  return lines.join('\n')
}

export interface DeviationResult {
  score: number
  details: Record<string, { expected: number; actual: number; delta: number }>
}

export function compareFingerprint(
  expected: StyleFingerprint,
  actual: StyleFingerprint
): DeviationResult {
  const dims: (keyof Pick<StyleFingerprint,
    'avgSentenceLength' | 'dialogueDensity' | 'avgParagraphLength' |
    'connectorDensity' | 'sentenceLengthCV' | 'metaphorDensityPer500'
  >)[] = [
    'avgSentenceLength', 'dialogueDensity', 'avgParagraphLength',
    'connectorDensity', 'sentenceLengthCV', 'metaphorDensityPer500'
  ]
  const details: DeviationResult['details'] = {}
  let totalDelta = 0
  let dimCount = 0

  for (const key of dims) {
    const exp = (expected[key] as number) ?? 0
    const act = (actual[key] as number) ?? 0
    if (exp === 0 && act === 0) continue
    const delta = exp > 0 ? Math.abs(act - exp) / exp : (act > 0 ? 1 : 0)
    details[key] = { expected: exp, actual: act, delta: Math.round(delta * 100) / 100 }
    totalDelta += delta
    dimCount++
  }

  const score = dimCount > 0 ? Math.round((totalDelta / dimCount) * 100) / 100 : 0
  return { score, details }
}
