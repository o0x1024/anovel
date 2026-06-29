import { stripForbiddenNotIsPatterns, stripEscalatedAdjectivePatterns } from '../../shared/normalize-body-text'

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

const CONNECTOR_PATTERNS = ['然而', '因此', '总的来说', '与此同时', '不仅如此', '此外', '综上', '尽管如此', '值得注意的是', '总而言之']
const TEMPLATE_PATTERNS = [
  '心中涌起一股', '眼中闪过一丝', '嘴角微微上扬', '不禁', '仿佛', '宛如',
  '在这个', '随着', '逐渐',
  '不是', '而是'
]

const FILM_SHOT_PATTERNS: RegExp[] = [
  /(?:目光|视线|眼神)(?:落在|扫过|越过|移到|停在|掠过).{0,15}上/g,
  /(?:他|她)(?:转身|回过头|抬起头|低下头|站起身|迈步|停下脚步)[^，。]{0,6}[。，]/g,
  /嘴角微微(?:上扬|勾起|一弯)/g,
  /脚步(?:一顿|顿了顿|微微一顿)/g,
  /缓缓(?:开口|站起身|回过头|转过身|抬起头)/g,
  /四目相对/g,
]

// AI 味心理/反应模板句：僵住类、精确秒数反应、裸心理标注、瞳孔/呼吸骤变
const REACTION_TEMPLATE_PATTERNS: { pat: RegExp; label: string }[] = [
  { pat: /(?:整个人|身体|身子|动作|手指|指尖|手|笑|嘴角|脸上的笑|表情)僵在(?:原地|半空|脸上|原地不动)?/g, label: '僵住类反应' },
  { pat: /僵住了/g, label: '僵住类反应' },
  { pat: /(?:愣|呆|怔|停顿|沉默|僵)了(?:两|三|几|半)\s*秒/g, label: '精确秒数反应' },
  { pat: /(?:他|她|它)(?:心想|心里想|心说)/g, label: '裸心理标注' },
  { pat: /(?:暗想|暗道|心中暗想|心中暗道)/g, label: '裸心理标注' },
  { pat: /瞳孔(?:骤缩|剧烈收缩|微缩|骤然收缩|一缩|微微收缩|蓦然一缩)/g, label: '瞳孔骤变反应' },
  { pat: /呼吸(?:一滞|停滞|一紧|一窒|骤停)/g, label: '呼吸骤变反应' },
]

// ---------------------------------------------------------------------------
//  机械对话标注：AI 高频使用 "对话"他说，/ "对话"她问。 这种裸标注
//  人类网文作者几乎不用，而是用 "说道/问道" 并附带动作、语气、神态描写
//  例：✗ "走吧。"他说。  ✓ "走吧。"他头也不回的说道。
// ---------------------------------------------------------------------------

const MECHANICAL_DIALOGUE_TAG_PATTERNS: RegExp[] = [
  /["""][他她]说[，。！？\n]/g,
  /["""][他她]问[，。！？\n]/g,
  /["""][\u4e00-\u9fff]{1,4}说[，。！？\n]/g,
  /["""][\u4e00-\u9fff]{1,4}问[，。！？\n]/g,
]


function detectMultiplePeriodsPerParagraph(text: string): { count: number; examples: string[] } {
  const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(Boolean)
  const examples: string[] = []
  let count = 0
  for (const p of paragraphs) {
    const n = (p.match(/。/g) ?? []).length
    if (n > 1) {
      count++
      if (examples.length < 3) examples.push(p.slice(0, 50))
    }
  }
  return { count, examples }
}

function detectDialogueActionSandwich(text: string): { count: number; examples: string[] } {
  const matches = text.match(/["“「][^"”」\n]{1,80}[。！？]["”」][^\n"“「]{1,40}[，,]["“「]/g) ?? []
  return {
    count: matches.length,
    examples: matches.slice(0, 3).map(m => m.slice(0, 60))
  }
}

function detectMechanicalDialogueTags(text: string): { count: number; examples: string[] } {
  let totalHits = 0
  const examples: string[] = []

  for (const pat of MECHANICAL_DIALOGUE_TAG_PATTERNS) {
    const matches = text.match(pat) ?? []
    for (const m of matches) {
      const core = m.replace(/^["""]/, '').replace(/[，。！？\n]$/, '')
      if (core.endsWith('说道') || core.endsWith('问道') || core.endsWith('道')) continue
      if (/(?:笑|冷|怒|急|沉声|轻声|低声|大声|淡淡|缓缓|森然|冷冷|温声|厉声)/.test(core)) continue
      totalHits++
      if (examples.length < 4) {
        examples.push(m.slice(0, 20))
      }
    }
  }
  return { count: totalHits, examples }
}

const CLOSURE_PATTERNS: RegExp[] = [
  /这一刻[，,]?(?:他|她)?(?:明白|懂得|知道|意识到)/g,
  /或许[，,]?这(?:便|就)是/g,
  /对于.{2,8}而言/g,
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

/**
 * 电报式短句连发检测：3句以上连续≤10字的短句（不含对话）。
 * AI 偏好用"抬起头。看着他。没说话。"这种镜头式碎片句制造伪文学感。
 */
function detectTelegraphicStaccato(text: string): { count: number; examples: string[] } {
  const sentences = text.split(/(?<=[。！？])/g).filter(s => s.trim())
  let groupCount = 0
  let runLen = 0
  let runStart = 0
  const examples: string[] = []

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i].trim()
    const isDialogue = /[""「『]/.test(s)
    const pureLen = s.replace(/[^\u4e00-\u9fff\w]/g, '').length

    if (!isDialogue && pureLen <= 10 && pureLen >= 2) {
      if (runLen === 0) runStart = i
      runLen++
    } else {
      if (runLen >= 3) {
        groupCount++
        if (examples.length < 3) {
          examples.push(sentences.slice(runStart, runStart + Math.min(runLen, 4)).map(s => s.trim()).join(''))
        }
      }
      runLen = 0
    }
  }
  if (runLen >= 3) {
    groupCount++
    if (examples.length < 3) {
      examples.push(sentences.slice(runStart, runStart + Math.min(runLen, 4)).map(s => s.trim()).join(''))
    }
  }

  return { count: groupCount, examples }
}

/**
 * 平行否定/肯定结构检测："没X，也没Y" / "不X，也不Y" / "没X，没Y"
 * 以及 "X着Y，Z着W" 式对称动作。
 */
function detectParallelNegation(text: string): { count: number; examples: string[] } {
  const patterns: RegExp[] = [
    /没[^，。！？]{1,8}[，,](?:也|又|更)?没[^。！？]{1,10}[。！？]/g,
    /不[^，。！？]{1,8}[，,](?:也|又|更)?不[^。！？]{1,10}[。！？]/g,
    /没有[^，。！？]{1,8}[，,](?:也|又)?没有[^。！？]{1,10}[。！？]/g,
    /既没[^，。！？]{1,10}[，,]也没[^。！？]{1,10}[。！？]/g,
    /既不[^，。！？]{1,10}[，,]也不[^。！？]{1,10}[。！？]/g,
  ]

  let total = 0
  const examples: string[] = []
  for (const pat of patterns) {
    const matches = text.match(pat) ?? []
    total += matches.length
    for (const m of matches) {
      if (examples.length < 3) examples.push(m.slice(0, 25))
    }
  }
  return { count: total, examples }
}

/**
 * 动词回声检测：同一双字动词在相邻句/分句中出现两次。
 * "盯着系统面板，已经盯了一刻钟" — 同一动词的不同时态/体重复。
 */
function detectVerbEcho(text: string): { count: number; examples: string[] } {
  const sentences = text.split(/[。！？]+/).filter(s => s.trim().length > 4)
  let total = 0
  const examples: string[] = []

  for (const sent of sentences) {
    const clauses = sent.split(/[，,；]/).filter(c => c.trim().length > 2)
    if (clauses.length < 2) continue

    const verbRe = /[\u4e00-\u9fff]{2}(?=[着了过得])/g
    for (let i = 0; i < clauses.length - 1; i++) {
      const verbs1 = new Set((clauses[i].match(verbRe) ?? []))
      if (verbs1.size === 0) continue
      for (let j = i + 1; j < Math.min(i + 3, clauses.length); j++) {
        const verbs2 = clauses[j].match(verbRe) ?? []
        for (const v of verbs2) {
          if (verbs1.has(v)) {
            total++
            if (examples.length < 3) {
              examples.push(`${v}...${v}`)
            }
            break
          }
        }
      }
    }
  }

  return { count: total, examples }
}

/**
 * 形容词回环递进："X很Y，Y得连Z都W" / "我语气很平，"
 * AI 用此句式给主角贴"冷静克制"人设，发现应直接删除。
 */
function detectEscalatedAdjectiveEcho(text: string): { count: number; examples: string[] } {
  const before = text
  const after = stripEscalatedAdjectivePatterns(text)
  if (before === after) return { count: 0, examples: [] }

  const patterns: RegExp[] = [
    /[^，。！？\n""「『]{0,12}很(平|稳|淡|冷|轻|慢|沉)[，,]\1得连[^。！？\n]+[。！？]?/g,
    /我(?:的)?(?:声音|语气|声线)?很(平|稳|淡|冷|轻|慢)[，,][^。！？\n]*/g,
    /(?:声音|语气|声线|笔(?:触|画)|手|指)[^。！？\n]{0,6}很(平|稳|淡|冷)[，,]\1得连[^。！？\n]+/g
  ]

  let total = 0
  const examples: string[] = []
  for (const pat of patterns) {
    const matches = text.match(pat) ?? []
    total += matches.length
    for (const m of matches) {
      if (examples.length < 3) examples.push(m.slice(0, 30))
    }
  }
  return { count: Math.max(total, 1), examples }
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

  const strippedNotIs = stripForbiddenNotIsPatterns(text)
  if (strippedNotIs !== text) {
    issues.push({
      type: 'template',
      label: '禁用句式“不是…是/而是”',
      severity: 'warning',
      count: Math.max(1, text.length - strippedNotIs.length),
      examples: ['不是…是…', '不是…而是…']
    })
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

  let filmShotTotal = 0
  const filmShotExamples: string[] = []
  for (const pat of FILM_SHOT_PATTERNS) {
    const matches = text.match(pat) ?? []
    filmShotTotal += matches.length
    if (matches.length > 0 && filmShotExamples.length < 3 && matches[0]) {
      filmShotExamples.push(matches[0].slice(0, 20))
    }
  }
  if (filmShotTotal >= 2) {
    issues.push({
      type: 'film_shot_chain',
      label: `电影镜头链描写（${filmShotTotal}处）— 外部检测器最敏感特征`,
      severity: 'warning',
      count: filmShotTotal,
      examples: filmShotExamples.length > 0 ? filmShotExamples : ['目光落在…上', '嘴角微微上扬', '缓缓开口']
    })
  }

  let reactionTotal = 0
  const reactionExamples: string[] = []
  for (const { pat, label } of REACTION_TEMPLATE_PATTERNS) {
    const matches = text.match(pat) ?? []
    if (matches.length > 0) {
      reactionTotal += matches.length
      if (reactionExamples.length < 3) {
        reactionExamples.push(`${label}「${matches[0]}」`)
      }
    }
  }
  if (reactionTotal >= 1) {
    issues.push({
      type: 'reaction_template',
      label: `AI味心理/反应模板句（${reactionTotal}处）— "整个人僵住了""愣了三秒""她心想""瞳孔骤缩""呼吸一滞"`,
      severity: 'warning',
      count: reactionTotal,
      examples: reactionExamples.length > 0 ? reactionExamples : ['整个人僵住了', '愣了三秒', '她心想', '瞳孔骤缩', '呼吸一滞']
    })
  }

  let closureTotal = 0
  for (const pat of CLOSURE_PATTERNS) {
    closureTotal += (text.match(pat) ?? []).length
  }
  if (closureTotal >= 1) {
    issues.push({
      type: 'closure_summary',
      label: `总结收束句（${closureTotal}处）— "这一刻他明白了…""或许这便是…"`,
      severity: 'warning',
      count: closureTotal,
      examples: ['这一刻他明白了…', '或许这便是…']
    })
  }

  const paragraphPeriodResult = detectMultiplePeriodsPerParagraph(text)
  if (paragraphPeriodResult.count >= 1) {
    issues.push({
      type: 'multiple_periods_per_paragraph',
      label: `单段多句号（${paragraphPeriodResult.count}段）— 每段最多 1 个句号`,
      severity: 'warning',
      count: paragraphPeriodResult.count,
      examples: paragraphPeriodResult.examples
    })
  }

  const sandwichDialogue = detectDialogueActionSandwich(text)
  if (sandwichDialogue.count >= 1) {
    issues.push({
      type: 'dialogue_action_sandwich',
      label: `动作插入对话中间（${sandwichDialogue.count}处）— 夹心对话结构`,
      severity: 'warning',
      count: sandwichDialogue.count,
      examples: sandwichDialogue.examples
    })
  }

  const mechDialogue = detectMechanicalDialogueTags(text)
  if (mechDialogue.count >= 2) {
    issues.push({
      type: 'mechanical_dialogue_tag',
      label: `机械对话标注（${mechDialogue.count}处）— "他说，""她问。"式裸标注`,
      severity: 'warning',
      count: mechDialogue.count,
      examples: mechDialogue.examples.length > 0
        ? mechDialogue.examples
        : ['"走吧。"他说，', '"真的？"她问。']
    })
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

  // -----------------------------------------------------------------------
  //  电报式短句连发：3句以上连续≤10字短句（"抬起头。看着他。没说话。"）
  //  AI 高频使用此节奏模拟"文学感"，人类网文极少出现
  // -----------------------------------------------------------------------
  const staccatoResult = detectTelegraphicStaccato(text)
  if (staccatoResult.count >= 1) {
    issues.push({
      type: 'telegraphic_staccato',
      label: `电报式短句连发（${staccatoResult.count}组）— 连续≤10字断句堆砌`,
      severity: 'warning',
      count: staccatoResult.count,
      examples: staccatoResult.examples.length > 0
        ? staccatoResult.examples
        : ['抬起头。看着他。没说话。']
    })
  }

  // -----------------------------------------------------------------------
  //  平行否定/肯定结构："没X，也没Y" / "不X，也不Y" / "没X，没Y"
  //  AI 极高频使用对称否定，人类作者偏好不对称表达
  // -----------------------------------------------------------------------
  const parallelNeg = detectParallelNegation(text)
  if (parallelNeg.count >= 2) {
    issues.push({
      type: 'parallel_negation',
      label: `平行否定/肯定结构（${parallelNeg.count}处）— "没X，也没Y"式对称`,
      severity: 'warning',
      count: parallelNeg.count,
      examples: parallelNeg.examples.length > 0
        ? parallelNeg.examples
        : ['没喝，也没催她']
    })
  }

  // -----------------------------------------------------------------------
  //  动词回声：同一动词在相邻句/分句中重复使用（"盯着…，已经盯了…"）
  //  AI 偏好用动词重复制造节奏感，人类作者倾向换词或省略
  // -----------------------------------------------------------------------
  const verbEcho = detectVerbEcho(text)
  if (verbEcho.count >= 2) {
    issues.push({
      type: 'verb_echo',
      label: `动词回声（${verbEcho.count}处）— 相邻句中同一动词重复`,
      severity: 'info',
      count: verbEcho.count,
      examples: verbEcho.examples.length > 0
        ? verbEcho.examples
        : ['盯着…已经盯了']
    })
  }

  const adjEcho = detectEscalatedAdjectiveEcho(text)
  if (adjEcho.count >= 1) {
    issues.push({
      type: 'escalated_adjective_echo',
      label: `形容词回环递进（${adjEcho.count}处）— "X很Y，Y得连Z都W" / "语气很平"`,
      severity: 'warning',
      count: adjEcho.count,
      examples: adjEcho.examples.length > 0
        ? adjEcho.examples
        : ['声音很平，平得连…', '我语气很平，']
    })
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
  '你是文字编辑，只输出修复指令 JSON，绝不输出全文。',
  '针对正文中的明显 AI 痕迹，输出对应的替换指令，进行最小必要改写。',
  '',
  '【改写原则】',
  '1. 仅修改命中的问题句：连接词堆叠、模板化情绪句、明显解释腔、机械对话标注。',
  '2. 修复机械对话标注：“他说，”“她问。”等裸标注，改为附带动作/神态/语气的写法；但不要把动作插进同一段对话中间。',
  '   ✗ “走吧。”他说。→ ✓ “走吧。”他头也不回的说道。',
  '   ✗ “真的？”她问。→ ✓ “真的？”她皱了下眉。',
  '   也可省略标注让对话自然衔接，或用动作段代替说话标签。',
  '3. 修复电报式短句连发：连续3句以上≤10字的断句（“抬起头。看着他。没说话。”），合并或修改打破机械节奏。',
  '4. 修复平行否定结构：“没X，也没Y”“不X，也不Y”，改为不对称表达或只保留一个否定。',
  '5. 修复动词回声：相邻句中同一动词重复（“盯着…盯了”），换用近义词或省略重复。',
  '6. 修复形容词回环递进：“X很Y，Y得连Z都W”“我语气很平，”等假装冷静的标签句，直接删除，不要换成同类模板。',
  '7. 修复单段多句号：每段最多保留 1 个“。”，多余句号改逗号、分号或拆成新段。',
  '8. 修复“不是A，而是B”“不是A，是B”“这不是A，这是B”：删除该句式，改成直接叙述或动作呈现。',
  '9. 修复动作插入对话中间：把动作移到对话前后独立成段，完整台词单独成段。',
  '',
  '【输出格式 — 严格遵守，只输出 JSON，不要有任何其他文字】',
  '{"patches": [{"find": "需要修改的原文精确片段", "replace": "修改后的片段"}]}',
  '',
  'find 规则：',
  '1. 必须是原文中精确存在的、唯一的字符串（含标点）。',
  '2. 长度建议 >= 10 字以确保唯一性；如果较短，请向左右扩展原文直到足够唯一。',
  '3. 只修改受 AI 痕迹影响的段落/句子，其余未提及的文字保持原封不动。',
  '',
  '若无明显 AI 痕迹或无需修改，请输出：{"patches": []}'
].join('\n')
