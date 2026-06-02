export interface AiTraceIssue {
  type: string
  label: string
  severity: 'warning' | 'info'
  count: number
  examples: string[]
}

export interface AiTraceReport {
  issues: AiTraceIssue[]
  totalScore: number
  summary: string
}

const CONNECTOR_PATTERNS = ['然而', '因此', '总的来说', '与此同时', '不仅如此', '此外', '综上']
const TEMPLATE_PATTERNS = [
  '心中涌起一股', '眼中闪过一丝', '嘴角微微上扬', '不禁', '仿佛', '宛如',
  '在这个', '随着', '逐渐'
]

const METAPHOR_PATTERNS = [
  /像[^。！？\n]{2,20}(?:一样|似的|般)/g,
  /如同[^。！？\n]{2,20}/g,
  /仿佛[^。！？\n]{2,20}/g,
  /宛如[^。！？\n]{2,20}/g,
  /好似[^。！？\n]{2,20}/g,
  /犹如[^。！？\n]{2,20}/g,
  /像是[^。！？\n]{2,20}/g
]

function detectMetaphorDensity(text: string): { count: number; per500: number } {
  let count = 0
  for (const p of METAPHOR_PATTERNS) {
    count += (text.match(p) ?? []).length
  }
  const chars = text.replace(/\s/g, '').length
  return { count, per500: chars > 0 ? (count / (chars / 500)) : 0 }
}

function detectSentenceBurstiness(text: string): { cv: number; shortRatio: number; avgLen: number } {
  const sentences = text.split(/[。！？!?…]+/).filter(s => s.trim().length > 0)
  if (sentences.length < 5) return { cv: 1, shortRatio: 0.2, avgLen: 20 }
  const lengths = sentences.map(s => s.replace(/\s/g, '').length)
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length
  const variance = lengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / lengths.length
  const cv = avg > 0 ? Math.sqrt(variance) / avg : 0
  const shortCount = lengths.filter(l => l <= 6).length
  return { cv, shortRatio: shortCount / lengths.length, avgLen: avg }
}

function detectEmotionalSaturation(text: string): { ratio: number; consecutiveHigh: number } {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim())
  if (paragraphs.length < 3) return { ratio: 0, consecutiveHigh: 0 }

  const EMOTION_MARKERS = [
    '心', '泪', '哭', '笑', '颤', '痛', '暖', '冷', '怕', '爱', '恨',
    '喜', '悲', '怒', '惊', '叹', '望', '盼', '忍', '舍',
    '目光', '眼', '呼吸', '心跳', '胸', '感觉', '感到', '觉得'
  ]

  let highEmotionCount = 0
  let maxConsecutive = 0
  let currentConsecutive = 0

  for (const p of paragraphs) {
    const pClean = p.replace(/\s/g, '')
    let emotionHits = 0
    for (const m of EMOTION_MARKERS) {
      emotionHits += (pClean.match(new RegExp(m, 'g')) ?? []).length
    }
    const density = pClean.length > 0 ? emotionHits / (pClean.length / 100) : 0
    if (density > 2.5) {
      highEmotionCount++
      currentConsecutive++
      maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
    } else {
      currentConsecutive = 0
    }
  }

  return {
    ratio: highEmotionCount / paragraphs.length,
    consecutiveHigh: maxConsecutive
  }
}

export function detectAiTraces(content: string): AiTraceReport {
  const issues: AiTraceIssue[] = []
  const text = content.trim()
  if (!text) {
    return { issues: [], totalScore: 0, summary: '无内容' }
  }

  for (const word of CONNECTOR_PATTERNS) {
    const matches = text.match(new RegExp(word, 'g')) ?? []
    if (matches.length >= 2) {
      issues.push({
        type: 'connector',
        label: `过度连接词「${word}」`,
        severity: 'warning',
        count: matches.length,
        examples: [word]
      })
    }
  }

  for (const pat of TEMPLATE_PATTERNS) {
    const matches = text.match(new RegExp(pat, 'g')) ?? []
    if (matches.length >= 1) {
      issues.push({
        type: 'template',
        label: `模板化表达「${pat}」`,
        severity: 'warning',
        count: matches.length,
        examples: [pat]
      })
    }
  }

  const paragraphs = text.split(/\n\n+/).filter(p => p.trim())
  const paraLengths = paragraphs.map(p => p.replace(/\s/g, '').length)
  if (paraLengths.length >= 3) {
    const avg = paraLengths.reduce((a, b) => a + b, 0) / paraLengths.length
    const variance = paraLengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / paraLengths.length
    if (variance < avg * 0.1) {
      issues.push({
        type: 'structure',
        label: '段落长度过于规整',
        severity: 'info',
        count: paragraphs.length,
        examples: ['各段长度接近，缺乏节奏变化']
      })
    }
  }

  const metaphor = detectMetaphorDensity(text)
  if (metaphor.per500 > 1.2) {
    issues.push({
      type: 'metaphor_density',
      label: `修辞密度过高（${metaphor.per500.toFixed(1)}处/500字）`,
      severity: 'warning',
      count: metaphor.count,
      examples: ['比喻/拟人/通感堆积，人类作者通常 ≤1 处/500字']
    })
  }

  const burst = detectSentenceBurstiness(text)
  if (burst.cv < 0.4) {
    issues.push({
      type: 'low_burstiness',
      label: `句长过于均匀（变异系数 ${burst.cv.toFixed(2)}）`,
      severity: 'warning',
      count: Math.round(burst.cv * 100),
      examples: [`句长变异系数 ${burst.cv.toFixed(2)}，人类写作通常 > 0.6；缺少碎片短句和超长句的交替`]
    })
  }
  if (burst.shortRatio < 0.08 && paraLengths.length >= 3) {
    issues.push({
      type: 'no_short_sentences',
      label: `几乎没有碎片短句（≤6字句仅占 ${Math.round(burst.shortRatio * 100)}%）`,
      severity: 'info',
      count: Math.round(burst.shortRatio * 100),
      examples: ['人类写作中碎片句（"没有。""他走了。"）通常占 10-25%']
    })
  }

  const emotion = detectEmotionalSaturation(text)
  if (emotion.ratio > 0.7 && paragraphs.length >= 4) {
    issues.push({
      type: 'emotional_saturation',
      label: `情感饱和度过高（${Math.round(emotion.ratio * 100)}% 段落为高情感密度）`,
      severity: 'warning',
      count: Math.round(emotion.ratio * 100),
      examples: ['缺少"白开水"段落（纯叙事/纯环境/纯动作的低情感密度段）']
    })
  }
  if (emotion.consecutiveHigh >= 4) {
    issues.push({
      type: 'no_emotional_rest',
      label: `连续 ${emotion.consecutiveHigh} 段高情感密度，无降温段`,
      severity: 'info',
      count: emotion.consecutiveHigh,
      examples: ['人类写作在情感高潮后通常有冷叙述段过渡']
    })
  }

  const totalScore = Math.min(10, issues.reduce((s, i) => {
    if (i.severity === 'warning') return s + Math.min(i.count, 5) * 1.5
    return s + Math.min(i.count, 5) * 0.5
  }, 0))
  const summary = issues.length === 0
    ? '未检测到明显 AI 痕迹'
    : `检测到 ${issues.length} 类 AI 痕迹特征（评分 ${Math.round(totalScore * 10) / 10}/10），建议人工润色`

  return { issues, totalScore: Math.round(totalScore * 10) / 10, summary }
}

export const AI_TRACE_POLISH_PROMPT = [
  '你是文字润色专家，消除以下文本中的 AI 生成痕迹。核心原则：像一个赶稿的人类作者而非一个力求完美的AI。',
  '',
  '具体操作：',
  '1. 减少「然而/因此/总的来说」等连接词堆砌，用具体动作句代替过渡',
  '2. 替换「心中涌起一股/眼中闪过一丝」等模板化情感表达，改用身体细节',
  '3. 大幅削减比喻密度——每500字最多保留1处比喻，其余改为白描',
  '4. 打破句长均匀性——插入碎片短句（3-6字），打断长句连续',
  '5. 添加 2-3 个"白开水"段落——纯说事/纯写环境，不带任何修辞',
  '6. 在叙述中掺入意外的具体细节（数字、品牌名、不优美的琐事）',
  '7. 情感高潮段后加入冷叙述段降温',
  '8. 保持原意和情节不变，只输出润色后的正文'
].join('\n')
