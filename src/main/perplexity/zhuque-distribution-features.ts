export interface ZhuqueDistributionFeatures {
  sequenceRegularity: number
  informationUniformity: number
  causalClosure: number
  voiceStability: number
  templateDensity: number
  windowRiskP75: number
  peakWindowRisk: number
  highRiskWindowShare: number
  documentRisk: number
  reasons: string[]
  windowEvidence: ZhuqueWindowEvidence[]
}

export interface ZhuqueWindowEvidence {
  start: number
  end: number
  risk: number
}

interface SentenceProfile {
  text: string
  length: number
  semanticLoad: number
  dominantFunction: string
  dialogue: number
  emotion: number
  explanation: number
  roleCount: number
  isDialogue: boolean
}

const DIALOGUE_PATTERN = /[“”「」『』]/g
const EMOTION_PATTERN = /(心|胸口|神智|恐惧|害怕|愤怒|恼|惊|慌|痛|痒|冷|僵|颤|恨|喜|笑|哭|泪)/g
const EXPLANATION_PATTERN = /(因为|所以|由于|因而|因此|为了|免得|才|也就|说明|意味着|原因|那是|原来|确定|确认|显然|可见|稍不|直到|足足)/g
const BACKGROUND_PATTERN = /(此前|以前|上个月|半年前|多年前|从前|曾经|本来|原本|自从|后来)/g
const ENVIRONMENT_PATTERN = /(风|雨|雪|雾|天|夜|墙|门|窗|庙|街|镇|屋|光|声|气味|空气)/g
const ACTION_PATTERN = /(走|跑|站|坐|靠|抬|低|摸|拿|捡|看|听|说|问|答|笑|骂|踹|推|拉|按|蹭|转|甩|塞|藏|钻|刮|吹|踩|响)/g
const TEMPLATE_PATTERN = /(仿佛.{0,12}(?:一般|似的)|不由得|微微一怔|眼底闪过一丝|眼中闪过一丝|涌上心头|呼吸一滞|瞳孔骤缩|然而[，,]|就在这时|他并不知道|这一刻.{0,8}明白)/g
const CLOSURE_PATTERN = /(?:做|说|看|听|等|藏|摸|按|确认|确定).{0,24}(?:因为|为了|免得|才|以便|说明|意味着)|(?:因为|为了|由于).{0,28}(?:所以|才|便|就)/g

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value))
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function std(values: number[]): number {
  if (values.length <= 1) return 0
  const avg = mean(values)
  return Math.sqrt(mean(values.map(value => (value - avg) ** 2)))
}

function cv(values: number[]): number {
  const avg = mean(values)
  return avg > 0 ? std(values) / avg : 0
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;…])|\n+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.replace(/\s/g, '').length >= 4)
}

function uniqueBigramRatio(text: string): number {
  const chars = [...text.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '')]
  if (chars.length < 3) return 1
  const bigrams = new Set<string>()
  for (let i = 0; i < chars.length - 1; i++) bigrams.add(chars[i] + chars[i + 1])
  return bigrams.size / (chars.length - 1)
}

function dominantFunction(text: string): string {
  if (count(text, DIALOGUE_PATTERN) >= 2) return 'dialogue'
  const scores: Array<[string, number]> = [
    ['explanation', count(text, EXPLANATION_PATTERN) + count(text, CLOSURE_PATTERN) * 2],
    ['background', count(text, BACKGROUND_PATTERN) * 2],
    ['emotion', count(text, EMOTION_PATTERN)],
    ['environment', count(text, ENVIRONMENT_PATTERN)],
    ['action', count(text, ACTION_PATTERN)]
  ]
  scores.sort((a, b) => b[1] - a[1])
  return scores[0][1] > 0 ? scores[0][0] : 'statement'
}

function profileSentence(text: string): SentenceProfile {
  const cleanLength = Math.max(1, text.replace(/\s/g, '').length)
  const actions = count(text, ACTION_PATTERN)
  const explanations = count(text, EXPLANATION_PATTERN) + count(text, CLOSURE_PATTERN)
  const background = count(text, BACKGROUND_PATTERN)
  const dialogueHits = count(text, DIALOGUE_PATTERN)
  const emotionHits = count(text, EMOTION_PATTERN)
  const environmentHits = count(text, ENVIRONMENT_PATTERN)
  const clauses = Math.max(1, count(text, /[，,；;：:]/g) + 1)
  const novelty = uniqueBigramRatio(text)
  return {
    text,
    length: cleanLength,
    semanticLoad: (actions * 1.4 + explanations * 1.8 + background + clauses * 0.7) / Math.sqrt(cleanLength) * novelty,
    dominantFunction: dominantFunction(text),
    dialogue: dialogueHits / cleanLength,
    emotion: emotionHits / cleanLength,
    explanation: explanations / cleanLength,
    roleCount: [actions, explanations, background, dialogueHits >= 2 ? 1 : 0, emotionHits, environmentHits]
      .filter(value => value > 0).length,
    isDialogue: dialogueHits >= 2
  }
}

function normalizedEntropy(values: string[]): number {
  if (values.length <= 1) return 0
  const frequencies = new Map<string, number>()
  for (const value of values) frequencies.set(value, (frequencies.get(value) ?? 0) + 1)
  const entropy = [...frequencies.values()].reduce((sum, n) => {
    const p = n / values.length
    return sum - p * Math.log2(p)
  }, 0)
  const maximum = Math.log2(Math.min(values.length, Math.max(2, frequencies.size)))
  return maximum > 0 ? entropy / maximum : 0
}

function sequenceRegularity(profiles: SentenceProfile[]): number {
  if (profiles.length < 5) return 45
  const functions = profiles.map(profile => profile.dominantFunction)
  const transitions = functions.slice(1).map((value, index) => `${functions[index]}>${value}`)
  const transitionEntropy = normalizedEntropy(transitions)
  const repeatedTransitions = transitions.length
    ? 1 - new Set(transitions).size / transitions.length
    : 0
  const lengthVariation = cv(profiles.map(profile => profile.length))
  const orderlyLengthRisk = clamp((0.62 - lengthVariation) * 115)
  const multifunctionRatio = profiles.filter(profile => profile.roleCount >= 2).length / profiles.length
  return clamp(
    (1 - transitionEntropy) * 24 +
    repeatedTransitions * 16 +
    orderlyLengthRisk * 0.18 +
    multifunctionRatio * 48
  )
}

function informationUniformity(profiles: SentenceProfile[]): number {
  if (profiles.length < 5) return 45
  // 对话天然比叙述稀疏，混在一起会把正常的对话切换误当成信息波动。
  const narrativeProfiles = profiles.filter(profile => !profile.isDialogue)
  const loads = (narrativeProfiles.length >= 4 ? narrativeProfiles : profiles)
    .map(profile => profile.semanticLoad)
  const loadCv = cv(loads)
  const activeProfiles = narrativeProfiles.length >= 4 ? narrativeProfiles : profiles
  const multifunctionRatio = activeProfiles.filter(profile => profile.roleCount >= 2).length / activeProfiles.length
  const singlePurposeRatio = activeProfiles.filter(profile => profile.roleCount <= 1).length / activeProfiles.length
  return clamp(
    multifunctionRatio * 68 +
    (0.82 - loadCv) * 42 -
    singlePurposeRatio * 18
  )
}

function causalClosure(text: string, profiles: SentenceProfile[]): number {
  if (profiles.length < 4) return 35
  const explicit = count(text, EXPLANATION_PATTERN)
  const closed = count(text, CLOSURE_PATTERN)
  const explanationSentences = profiles.filter(profile => profile.explanation > 0).length
  const density = (explicit + closed * 1.7) / profiles.length
  const coverage = explanationSentences / profiles.length
  return clamp(density * 40 + coverage * 105)
}

function voiceStability(profiles: SentenceProfile[]): number {
  if (profiles.length < 8) return 40
  const windowSize = Math.max(3, Math.floor(profiles.length / 4))
  const windows: SentenceProfile[][] = []
  for (let start = 0; start < profiles.length; start += windowSize) {
    const window = profiles.slice(start, start + windowSize)
    if (window.length >= 2) windows.push(window)
  }
  if (windows.length < 3) return 40

  const narrativeWindows = windows.map(window => {
    const narrative = window.filter(profile => !profile.isDialogue)
    return narrative.length > 0 ? narrative : window
  })
  const dimensions = [
    narrativeWindows.map(window => mean(window.map(profile => profile.length))),
    narrativeWindows.map(window => mean(window.map(profile => profile.emotion))),
    narrativeWindows.map(window => mean(window.map(profile => profile.explanation))),
    narrativeWindows.map(window => mean(window.map(profile => profile.roleCount)))
  ].filter(values => mean(values) > 0.0001)
  const normalizedVariation = mean(dimensions.map(values => {
    const average = mean(values)
    return Math.min(1, std(values) / average)
  }))
  return clamp((0.72 - normalizedVariation) * 128)
}

function templateDensity(text: string, profiles: SentenceProfile[]): number {
  const hits = count(text, TEMPLATE_PATTERN)
  return clamp((hits / Math.max(1, profiles.length)) * 230)
}

export function analyzeZhuqueDistribution(
  text: string,
  tokenWindows: Array<{ start: number; end: number }>
): ZhuqueDistributionFeatures {
  const full = analyzeCore(text)
  const windowEvidence = tokenWindows.map(window => ({
    ...window,
    features: analyzeCore(text.slice(window.start, window.end))
  }))
  const windows = windowEvidence.map(window => window.features)
  const sequence = Math.max(full.sequenceRegularity, percentile(windows.map(item => item.sequenceRegularity), 0.75))
  const information = Math.max(full.informationUniformity, percentile(windows.map(item => item.informationUniformity), 0.75))
  const causal = Math.max(full.causalClosure, percentile(windows.map(item => item.causalClosure), 0.75))
  const voice = Math.max(full.voiceStability, percentile(windows.map(item => item.voiceStability), 0.75))
  const templates = Math.max(full.templateDensity, percentile(windows.map(item => item.templateDensity), 0.75))
  const windowRisks = windows.map(item => item.documentRisk)
  const windowRiskP75 = percentile(windowRisks, 0.75)
  const peakWindowRisk = Math.max(...windowRisks, 0)
  const highRiskWindowShare = windowRisks.length > 0
    ? windowRisks.filter(risk => risk >= 40).length / windowRisks.length * 100
    : 0

  // 长文本使用高分位窗口而非全文平均，防止后续对话或动作稀释局部生成轨迹。
  const documentRisk = clamp(Math.max(
    distributionRisk(sequence, information, causal, voice, templates),
    windowRiskP75
  ))
  const ranked: Array<[string, number]> = [
    ['段落功能序列过于规律', sequence],
    ['信息释放密度过于均匀', information],
    ['动作与原因持续即时闭合', causal],
    ['叙述语气和距离长期稳定', voice],
    ['常见AI小说模板密集', templates]
  ]
  const reasons = ranked
    .filter(([, score]) => score >= 58)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason]) => reason)
  if (peakWindowRisk >= 42 && highRiskWindowShare >= 10 && reasons.length < 3) {
    reasons.push('局部窗口生成轨迹集中')
  }
  if (documentRisk >= 38 && reasons.length === 0) {
    reasons.push('整篇结构风险持续偏高')
  }

  return {
    sequenceRegularity: round(sequence),
    informationUniformity: round(information),
    causalClosure: round(causal),
    voiceStability: round(voice),
    templateDensity: round(templates),
    windowRiskP75: round(windowRiskP75),
    peakWindowRisk: round(peakWindowRisk),
    highRiskWindowShare: round(highRiskWindowShare),
    documentRisk: round(documentRisk),
    reasons,
    windowEvidence: windowEvidence.map(window => ({
      start: window.start,
      end: window.end,
      risk: round(window.features.documentRisk)
    }))
  }
}

interface CoreDistributionFeatures {
  sequenceRegularity: number
  informationUniformity: number
  causalClosure: number
  voiceStability: number
  templateDensity: number
  documentRisk: number
}

function analyzeCore(text: string): CoreDistributionFeatures {
  const profiles = splitSentences(text).map(profileSentence)
  const sequence = sequenceRegularity(profiles)
  const information = informationUniformity(profiles)
  const causal = causalClosure(text, profiles)
  const voice = voiceStability(profiles)
  const templates = templateDensity(text, profiles)

  return {
    sequenceRegularity: sequence,
    informationUniformity: information,
    causalClosure: causal,
    voiceStability: voice,
    templateDensity: templates,
    documentRisk: distributionRisk(sequence, information, causal, voice, templates)
  }
}

function distributionRisk(sequence: number, information: number, causal: number, voice: number, templates: number): number {
  return clamp(
    sequence * 0.27 +
    information * 0.24 +
    causal * 0.25 +
    voice * 0.16 +
    templates * 0.08
  )
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0
  const ordered = [...values].sort((a, b) => a - b)
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * quantile) - 1))
  return ordered[index]
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
