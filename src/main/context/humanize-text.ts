import { normalizeBodyParagraphSpacing } from '../../shared/normalize-body-text'

/**
 * 后处理人性化模块
 *
 * 基于朱雀 AI 检测实验的结论，按权重优先级处理：
 *
 * 1. 【致命】消除电影镜头链（朱雀 F6: 人工特征↓81%）
 * 2. 【高危】消除书面连接词（朱雀 F4: 人工特征↓39%）
 * 3. 【中危】消除模板情感句/总结句（朱雀 F1/F5: ↓26%~27%）
 * 4. 高频AI词 → 低频人类替代词（降低 token 可预测性）
 * 5. 标点变异（改变分词边界）
 * 6. 随机插入口语化填充词（打破信息密度均匀性）
 * 7. 消除连续同长度句
 */

// ---------------------------------------------------------------------------
//  朱雀实验驱动的指纹消除（优先级最高的三层）
// ---------------------------------------------------------------------------

/**
 * 【致命级】消除电影镜头链——朱雀实验 F6: 注入镜头链使人工特征↓81%
 */
function eliminateFilmShotChains(text: string): string {
  let r = text
  r = r.replace(/(?:目光|视线|眼神)(?:落在|扫过|越过|移到|停在|掠过)([^，。！？]{1,15})上/g,
    (_m, t: string) => `看了眼${t}`)
  r = r.replace(/嘴角微微(?:上扬|勾起|一弯)/g, '咧了咧嘴')
  r = r.replace(/(?:缓缓|慢慢)(?:回过头|转过身|站起身|抬起头)/g, (m) =>
    m.replace(/缓缓|慢慢/, ''))
  r = r.replace(/脚步(?:一顿|顿了顿|微微一顿)/g, '停了一下')
  r = r.replace(/四目相对[^，。]{0,6}[。，]/g, '互相看了一眼，')
  return r
}

/**
 * 【高危级】消除书面连接词——朱雀实验 F4: 注入连接词使人工特征↓39%
 */
function eliminateConnectors(text: string): string {
  const map: [RegExp, string[]][] = [
    [/然而[，,]?/g, ['可', '但', '不过，', '']],
    [/因此[，,]?/g, ['所以', '这才', '']],
    [/此外[，,]?/g, ['另外', '还有', '']],
    [/与此同时[，,]?/g, ['这会儿', '这当口', '']],
    [/不仅如此[，,]?/g, ['', '不光这样']],
    [/尽管如此[，,]?/g, ['话虽这么说，', '即便这样，', '']],
    [/值得注意的是[，,]?/g, ['']],
    [/不难发现[，,]?/g, ['']],
    [/由此可见[，,]?/g, ['']],
    [/总而言之[，,]?/g, ['']],
  ]
  let r = text
  for (const [pattern, alts] of map) {
    r = r.replace(pattern, () => alts[Math.floor(Math.random() * alts.length)])
  }
  return r
}

/**
 * 【中危级】消除模板情感句和总结收束句
 * 朱雀实验 F1: 注入模板情感句→人工特征↓26%; F5: 注入总结句→↓27%
 */
function eliminateTemplateEmotions(text: string): string {
  let r = text
  r = r.replace(/(?:心中|内心|胸口)(?:涌起|泛起|升起|掠过)(?:一股|一阵|一丝)[^，。]{1,15}[，。]/g, '')
  r = r.replace(/(?:这一刻[，,]?(?:他|她)?(?:明白|懂得|知道|意识到了?))[^。]{0,20}。/g, '')
  r = r.replace(/(?:或许[，,]?这(?:便|就)是)[^。]{0,20}。/g, '')
  r = r.replace(/(?:对于[^，。]{2,8}而言)[^。]{0,15}。/g, '')
  return r
}

// ---------------------------------------------------------------------------

/** AI 偏好词 → 人类替代词（一对多，随机选取） */
const WORD_SUBSTITUTIONS: [RegExp, string[]][] = [
  [/微微/g, ['略微', '稍稍', '有点', '']],
  [/缓缓/g, ['慢慢', '不紧不慢地', '']],
  [/静静/g, ['安静地', '就那么', '']],
  [/默默/g, ['没吱声，', '没说话，', '']],
  [/不禁/g, ['忍不住', '没忍住', '']],
  [/凝视/g, ['盯着', '看着', '瞅着']],
  [/注视/g, ['看着', '瞅着', '瞧着']],
  [/目光/g, ['眼神', '视线', '眼睛']],
  [/端详/g, ['打量', '看了看']],
  [/驻足/g, ['停下', '站住', '站定']],
  [/伫立/g, ['站着', '杵着', '立在那']],
  [/踱步/g, ['走来走去', '溜达', '晃悠']],
  [/思绪/g, ['念头', '想法', '脑子里的东西']],
  [/心绪/g, ['心情', '情绪', '心里']],
  [/蔓延/g, ['扩散', '铺开', '散开']],
  [/弥漫/g, ['飘着', '散着', '充斥着']],
  [/涌上心头/g, ['冒出来', '蹿上来', '突然想起']],
  [/映入眼帘/g, ['看到了', '入了眼', '撞进视线']],
  [/不由自主/g, ['没忍住', '不自觉', '下意识']],
  [/情不自禁/g, ['忍不住', '没控制住', '下意识']],
  [/深邃/g, ['深', '幽深', '看不透']],
  [/温柔/g, ['轻', '柔和', '软']],
  [/轻柔/g, ['轻轻', '柔', '软']],
  [/清晰/g, ['清楚', '明白', '分明']],
  [/朦胧/g, ['模糊', '雾蒙蒙', '看不真切']],
  [/璀璨/g, ['亮', '晃眼', '扎眼']],
  [/绚烂/g, ['好看', '艳', '花花绿绿']],
  [/宁静/g, ['安静', '没声', '静']],
  [/寂静/g, ['安静', '没声', '静得慌']],
  [/喧嚣/g, ['吵', '闹', '嘈杂']],
  [/忽然/g, ['突然', '冷不丁', '猛地']],
  [/骤然/g, ['突然', '猛地', '一下子']],
  [/刹那/g, ['那一瞬', '那一下', '']],
  [/霎时/g, ['一下子', '立马', '']],
  [/瞬间/g, ['一下子', '一瞬', '那一下']],
  [/仿佛/g, ['好像', '像是', '跟']],
  [/宛如/g, ['像', '跟', '活像']],
  [/犹如/g, ['像', '跟…一样', '活脱脱']],
  [/如同/g, ['像', '跟', '好比']],
  [/随即/g, ['接着', '然后', '跟着']],
  [/旋即/g, ['接着', '紧跟着', '马上']],
  [/竟然/g, ['居然', '没想到', '']],
  [/在这一刻/g, ['这会儿', '']],
  [/在那一刻/g, ['那会儿', '']],
  [/此刻/g, ['这会儿', '眼下', '现在']],
  [/彼此/g, ['俩人', '相互', '互相']],
]

/** 从数组中随机取一个元素 */
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * 从参考文本中提取高频 2-4 字词组，用于替换时优先选择参考文本中的表达。
 */
export function buildStyleWordMap(referenceText: string): Map<string, number> {
  const freq = new Map<string, number>()
  if (!referenceText || referenceText.length < 100) return freq

  const segments = referenceText.split(/[。！？，、；：\s\n]+/).filter(s => s.length >= 2)
  for (const seg of segments) {
    for (let len = 2; len <= 4 && len <= seg.length; len++) {
      for (let i = 0; i <= seg.length - len; i++) {
        const word = seg.slice(i, i + len)
        if (/^[\u4e00-\u9fff]+$/.test(word)) {
          freq.set(word, (freq.get(word) ?? 0) + 1)
        }
      }
    }
  }

  const minFreq = 3
  for (const [w, c] of freq) {
    if (c < minFreq) freq.delete(w)
  }
  return freq
}

let _cachedStyleWordMap: Map<string, number> | null = null
let _cachedStyleWordMapSource = ''

function getOrBuildStyleWordMap(refText?: string): Map<string, number> | null {
  if (!refText) return null
  if (refText === _cachedStyleWordMapSource && _cachedStyleWordMap) return _cachedStyleWordMap
  _cachedStyleWordMap = buildStyleWordMap(refText)
  _cachedStyleWordMapSource = refText
  return _cachedStyleWordMap
}

/**
 * 词级替换：将 AI 高频词替换为低频人类用词。
 * 如果提供了参考文本词频表，优先使用参考文本中出现的词汇。
 */
function applyWordSubstitutions(text: string, skipRate = 0.3, styleWordMap?: Map<string, number> | null): string {
  let result = text
  for (const [pattern, alternatives] of WORD_SUBSTITUTIONS) {
    result = result.replace(pattern, (match) => {
      if (Math.random() < skipRate) return match

      if (styleWordMap && styleWordMap.size > 0) {
        const styleAlts = alternatives.filter(a => a && styleWordMap.has(a))
        if (styleAlts.length > 0) return pick(styleAlts)
      }

      const replacement = pick(alternatives)
      return replacement || match
    })
  }
  return result
}

/**
 * 标点变异：打破标点使用的均匀性
 * - 随机将部分逗号改为顿号或空格
 * - 随机将部分句号改为省略号
 * - 随机在对话前后添加换行
 */
function perturbPunctuation(text: string): string {
  let result = text

  // 随机将极少量逗号改为短暂停顿（不改太多，只扰动分布）
  result = result.replace(/，/g, (m) => {
    const r = Math.random()
    if (r < 0.03) return '、'
    return m
  })

  return result
}

/**
 * 口语化填充：在段落之间随机插入极短的过渡句。
 * 这些句子信息密度极低，能有效打破 AI 文本的高密度均匀性。
 */
const FILLER_SENTENCES = [
  '就这样。',
  '也没什么。',
  '挺好的。',
  '差不多吧。',
  '就那样。',
  '行吧。',
  '也对。',
  '没什么好说的。',
]

function insertFillerSentences(text: string, maxInserts = 2): string {
  const paragraphs = text.split('\n\n')
  if (paragraphs.length < 6) return text

  let insertCount = 0
  const result: string[] = []

  for (let i = 0; i < paragraphs.length; i++) {
    result.push(paragraphs[i])

    // 在段落间有小概率插入填充句（不在开头和结尾）
    if (i > 1 && i < paragraphs.length - 2 && insertCount < maxInserts) {
      const para = paragraphs[i]
      const isDialogue = para.includes('「') || para.includes('"') || para.includes('"')
      if (!isDialogue && Math.random() < 0.15) {
        result.push(pick(FILLER_SENTENCES))
        insertCount++
      }
    }
  }

  return result.join('\n\n')
}

/**
 * 消除连续同长度句：检测连续3句以上长度相近的情况，
 * 对中间的句子进行拆分或合并。
 */
function breakUniformSentences(text: string): string {
  const parts = text.split(/(\n\n+)/)
  const result: string[] = []

  for (const part of parts) {
    if (/^\n+$/.test(part)) {
      result.push(part)
      continue
    }

    const sentences = part.split(/(?<=[。！？])/g).filter(s => s.trim())
    if (sentences.length < 4) {
      result.push(part)
      continue
    }

    const processed: string[] = []
    for (let i = 0; i < sentences.length; i++) {
      const curr = sentences[i].replace(/\s/g, '').length
      const prev = i > 0 ? sentences[i - 1].replace(/\s/g, '').length : 0
      const next = i < sentences.length - 1 ? sentences[i + 1].replace(/\s/g, '').length : 0

      const prevSimilar = prev > 0 && Math.abs(curr - prev) < Math.max(curr, prev) * 0.25
      const nextSimilar = next > 0 && Math.abs(curr - next) < Math.max(curr, next) * 0.25

      if (prevSimilar && nextSimilar && curr > 15 && Math.random() < 0.4) {
        const commaIdx = sentences[i].indexOf('，', Math.floor(sentences[i].length * 0.3))
        if (commaIdx > 0 && commaIdx < sentences[i].length - 5) {
          processed.push(sentences[i].slice(0, commaIdx) + '。')
          processed.push(sentences[i].slice(commaIdx + 1))
          continue
        }
      }

      processed.push(sentences[i])
    }

    result.push(processed.join(''))
  }

  return result.join('')
}

/**
 * 句长节奏制造：主动打破句长均匀性，拉高 sentenceStd 与相邻句长变化率
 * （启发式检测器 30% 权重的核心指标）。
 *
 * 策略：检测连续 ≥3 句长度相近的「均匀段」，在其中随机做两种变换之一——
 *  ① 把相邻两句用逗号合并成一句长句（拔高峰值，拉高 std 与变化率）；
 *  ② 把一句长句在逗号处断成两句（制造一个短句）。
 * 仅对 10–40 字的中等句操作，避免破坏语义或对话。
 */
function diversifySentenceRhythm(text: string): string {
  const parts = text.split(/(\n\n+)/)
  const result: string[] = []

  for (const part of parts) {
    if (/^\n+$/.test(part)) {
      result.push(part)
      continue
    }

    const sentences = part.split(/(?<=[。！？])/g).filter(s => s.trim())
    if (sentences.length < 4) {
      result.push(part)
      continue
    }

    const lens = sentences.map(s => s.replace(/\s/g, '').length)
    const processed: string[] = []
    let i = 0
    while (i < sentences.length) {
      // 探测从 i 开始的均匀句群
      let runEnd = i + 1
      while (runEnd < sentences.length) {
        const a = lens[runEnd - 1]
        const b = lens[runEnd]
        if (a > 0 && Math.abs(a - b) < Math.max(a, b) * 0.22) runEnd++
        else break
      }
      const runLen = runEnd - i

      if (runLen >= 3 && Math.random() < 0.5) {
        // 在均匀群内做一次合并：把群内相邻两句并成一句
        const mergeAt = i + 1 + Math.floor(Math.random() * (runLen - 1))
        for (let j = i; j < runEnd; j++) {
          if (j === mergeAt && j < sentences.length) {
            const prev = sentences[j - 1].trim()
            const curr = sentences[j].trim()
            // 去掉前句末尾句号，用逗号连接
            const prevCore = prev.replace(/[。！？]+$/, '')
            const merged = `${prevCore}，${curr}`
            processed[processed.length - 1] = merged
            continue
          }
          processed.push(sentences[j])
        }
      } else {
        for (let j = i; j < runEnd; j++) processed.push(sentences[j])
      }
      i = runEnd
    }

    result.push(processed.join(''))
  }

  return result.join('')
}

/**
 * 信息密度均匀检测 + 插闲笔：
 * AI 文本段落信息密度高度均匀（每段都在「推进情节」），人味文本会有低密度的
 * 闲笔/感官白描段落。对密度过于均匀的相邻段落，往间隙插一句低信息密度感官句，
 * 打破均匀性（同时降困惑度——闲笔 token 更不可预测）。
 *
 * 密度代理指标：段落字数与其句末标点数的比值（句均字数）越接近，段落越「同质」。
 * 仅在相邻段落句均字数差异极小（均匀）时触发，且不在对话段附近插。
 */
const SENSORY_FILLERS = [
  '外头风停了，屋里安静得能听见钟走。',
  '茶凉了，没人顾上续。',
  '窗纸透进来一道光，落在桌角。',
  '远处有人喊了一嗓子，没听清喊什么。',
  '灶上的水咕嘟咕嘟响。',
  '他换了个姿势，椅子吱呀一声。',
  '天上云压得很低，像要下雨又没下。',
  '烟灰掉在膝盖上，他没掸。',
]

function infoDensityUniform(paragraphs: string[]): boolean {
  // 句均字数作为密度代理；相邻段落差异都极小 → 整体均匀
  if (paragraphs.length < 5) return false
  const densities = paragraphs.map(p => {
    const pure = p.replace(/\s/g, '').length
    const ends = (p.match(/[。！？]/g) || []).length
    return ends > 0 ? pure / ends : pure
  })
  let uniformNeighbors = 0
  for (let i = 1; i < densities.length; i++) {
    const a = densities[i - 1]
    const b = densities[i]
    if (Math.max(a, b) > 0 && Math.abs(a - b) / Math.max(a, b) < 0.12) uniformNeighbors++
  }
  return uniformNeighbors / (densities.length - 1) > 0.6
}

function insertSensoryFillers(text: string, maxInserts = 2): string {
  const paragraphs = text.split('\n\n')
  if (paragraphs.length < 5) return text
  if (!infoDensityUniform(paragraphs)) return text

  let insertCount = 0
  const result: string[] = []
  for (let i = 0; i < paragraphs.length; i++) {
    result.push(paragraphs[i])
    if (i > 1 && i < paragraphs.length - 2 && insertCount < maxInserts) {
      const para = paragraphs[i]
      const isDialogue = para.includes('「') || para.includes('"') || para.includes('"')
      const nextIsDialogue = paragraphs[i + 1].includes('「') || paragraphs[i + 1].includes('"')
      if (!isDialogue && !nextIsDialogue && Math.random() < 0.3) {
        result.push(pick(SENSORY_FILLERS))
        insertCount++
      }
    }
  }
  return result.join('\n\n')
}

/**
 * 孤立短句向前合并：极短的结论/断言句（≤8字，如"不动了。""没说话。"）
 * 应该附着到上一段末尾而非独占一段。
 *
 * 匹配条件：段落纯文字≤8字、非对话、前一段存在且非对话。
 */
function mergeOrphanedShortSentences(text: string): string {
  const paragraphs = text.split('\n\n')
  if (paragraphs.length < 2) return text

  const result: string[] = []

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i].trim()
    if (!p) continue

    const pureLen = p.replace(/[^\u4e00-\u9fff\w]/g, '').length
    const isDialogue = /^[""「『]/.test(p)
    const prevIdx = result.length - 1

    if (
      pureLen <= 8 &&
      !isDialogue &&
      prevIdx >= 0 &&
      !/^[""「『]/.test(result[prevIdx])
    ) {
      result[prevIdx] = result[prevIdx] + p
      continue
    }

    result.push(p)
  }

  return result.join('\n\n')
}

export interface HumanizeOptions {
  wordSubstitution?: boolean
  punctuationPerturb?: boolean
  fillerInsertion?: boolean
  breakUniform?: boolean
  /** 消除朱雀检测器最敏感的 AI 指纹（镜头链/连接词/模板句） */
  eliminateFingerprints?: boolean
  skipRate?: number
  referenceText?: string
}

/**
 * 对 AI 生成文本进行人性化后处理。
 * 通过词级替换、标点变异、填充句插入和句长均匀性打破
 * 来降低 token 级概率分布的均匀性。
 * 若提供 referenceText，替换时优先使用参考文本中的高频词汇。
 */
export function humanizeText(text: string, options: HumanizeOptions = {}): string {
  if (!text.trim()) return text

  const {
    wordSubstitution = true,
    punctuationPerturb = true,
    fillerInsertion = true,
    breakUniform = true,
    eliminateFingerprints = true,
    skipRate = 0.3,
    referenceText
  } = options

  const styleWordMap = referenceText ? getOrBuildStyleWordMap(referenceText) : null

  let result = text

  if (eliminateFingerprints) {
    result = eliminateFilmShotChains(result)
    result = eliminateConnectors(result)
    result = eliminateTemplateEmotions(result)
  }

  if (wordSubstitution) {
    result = applyWordSubstitutions(result, skipRate, styleWordMap)
  }

  if (breakUniform) {
    result = breakUniformSentences(result)
    result = diversifySentenceRhythm(result)
    result = mergeOrphanedShortSentences(result)
  }

  if (punctuationPerturb) {
    result = perturbPunctuation(result)
  }

  if (fillerInsertion) {
    result = insertFillerSentences(result)
    result = insertSensoryFillers(result)
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
  let hits = 0
  for (const [pattern] of WORD_SUBSTITUTIONS) {
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
