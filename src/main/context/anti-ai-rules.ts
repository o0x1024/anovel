import { coreSettingDAO, aiFavoriteDAO, writingStyleDAO } from '../db'
import { STYLE_CORE_DIRECTIVE } from './writing-techniques'
import { bodyWordCountBounds } from '../../shared/body-word-target'
import { stripDeterministicAiPatterns, stripForbiddenNotIsPatterns } from '../../shared/normalize-body-text'
import { MAX_STYLE_REFERENCE_TEXT_CHARS } from '../../shared/style-reference-limits'
import type { AiTraceIssue } from './ai-trace-detect'
import { computeDocMetrics, computeHeuristicAiScore } from '../perplexity/heuristic-detect'

const ANTI_AI_RULES_TYPE = 'anti_ai_rules'
const REFERENCE_TEXT_TYPE = 'reference_text'

// ---------------------------------------------------------------------------
//  正面示范对：每条禁令配一个「应该怎么写」的 before/after 对比
// ---------------------------------------------------------------------------

export interface AntiAiPreset {
  label: string
  rule: string
  /** before: AI 腔写法; after: 人味替代写法 */
  demo?: { before: string; after: string }
}

/** 表层规则：针对 AI 高频词汇和模板句式 */
export const SURFACE_ANTI_AI_PRESETS: AntiAiPreset[] = [
  {
    label: '禁电影镜头链',
    rule: '禁止"电影镜头链"式描写：不要逐帧写动作（"目光落在…上→嘴角微微上扬→缓缓开口"），用一句复合句概括或省略中间过程。禁止"目光落在/扫过…上""嘴角微微上扬""脚步一顿""缓缓开口/站起身/回过头"等镜头调度词',
    demo: {
      before: '他转过身，目光落在她手中的信封上。嘴角微微上扬，缓缓开口道："你来了。"',
      after: '他瞟了眼她手里攥着的信封，说了句"你来了"。'
    }
  },
  {
    label: '禁模板情感句',
    rule: '禁止使用「心中涌起一股」「眼中闪过一丝」「嘴角微微上扬」「不禁」「仿佛」「宛如」等模板化情感描写，改用具体的身体动作/感官细节传递情绪',
    demo: {
      before: '她心中涌起一股暖意，眼中闪过一丝柔情，嘴角微微上扬。',
      after: '她把脸埋进围巾里，鼻尖发烫。手指不知道什么时候攥住了袖口。'
    }
  },
  {
    label: '修辞去陈词',
    rule: '比喻与意象须具体、怪诞或带个人癖好，避免陈词滥调与「正确但无聊」的文学腔',
    demo: {
      before: '月光如水，洒在她如花似玉的脸上，宛如一幅美丽的画卷。',
      after: '月亮像一块没洗干净的盘子，白惨惨地挂在那儿，照得她脸上那道疤更明显了。'
    }
  },
  {
    label: '禁总结式段尾',
    rule: '禁止在段末或章末用总结、升华、点题句收束；用动作、对话或未完成的悬念代替',
    demo: {
      before: '经历了这一切，她终于明白了什么是真正的勇气。也许，这就是成长的代价吧。',
      after: '她把那封信叠好，塞进靴筒里。街上传来打更的梆子声。三更了。'
    }
  },
  {
    label: '对话口语化',
    rule: '对话须口语化、可含打断/省略/口头禅，符合角色声线，禁止每句对话都完整工整像说明文',
    demo: {
      before: '「我认为我们应该重新考虑这个计划，因为目前的情况已经发生了很大的变化。」',
      after: '「这计划，算了，不行。你自己看看外头那架势。」'
    }
  },
  {
    label: '禁机械对话标注',
    rule: '禁止"他说，""她问。""XX说。"等裸对话标注。禁止把人物动作插入同一段对话中间，尤其不要写「“前半句。”人物动作，“后半句。”」；动作必须放在对话前一段或后一段，或让完整台词单独成段。对话标注必须附带动作、神态、语气或环境描写，或省略标注让上下文暗示说话人',
    demo: {
      before: '"我先走了。"他说，"猫爬架放这儿。"\n"它们平时不这样。"她说。\n"秦浩？"林晚问。',
      after: '"我先走了。"他把猫爬架往墙角一搁，"放这儿。"\n"它们平时不这样。"她蹲下去戳了戳猫肚子。\n"秦浩？"林晚皱起了眉。'
    }
  },
  {
    label: '禁短促强否定收尾',
    rule: '禁止在动作场景中用"没/没有+单/双音节动词"作为短促结尾（制造伪冷酷感），应补充连贯动作或细节',
    demo: {
      before: '老太太端起茶杯，没喝。碎瓷溅上林薇的脚踝时，她没躲。',
      after: '老太太端起茶杯吹了吹浮沫，又原样搁回了桌上。碎瓷溅上脚踝，林薇连眼皮都没眨一下。'
    }
  },
  {
    label: '禁机械精确度量',
    rule: '禁止在日常动作或场景描写中滥用具体的度数、厘米/毫米等物理量词，应用模糊量词或具象参照物',
    demo: {
      before: '向外旋开15度，在第十七厘米的位置，上方三毫米处。',
      after: '向外旋开一条窄缝，差不多在中间偏上一点的位置。'
    }
  },
  {
    label: '禁形容词回环递进',
    rule: '禁止"X很Y，Y得连Z都W"式回环递进，以及"声音/语气/声线很平/稳/淡/冷"等假装冷静的人设标签。发现即删，不要换成同类写法',
    demo: {
      before: '她声音很平，平得连我自己都有点意外。"走吧。"',
      after: '"走吧。"'
    }
  }
]

/** 深层规则：针对 AI 检测器捕捉的统计分布特征（困惑度、突发性、修辞密度等） */
export const DEEP_ANTI_AI_PRESETS: AntiAiPreset[] = [
  {
    label: '白开水段落',
    rule: '每章须包含至少 2-3 个"白开水"段落：纯叙事/纯交代/纯环境的平淡段，不带任何比喻、情感渲染或象征意味，只说事实。情感高潮前后必须有这种"休息段"降温',
    demo: {
      before: '阳光透过窗帘的缝隙，如同金色的丝线般洒落在地板上，温暖而柔和。空气中弥漫着淡淡的茉莉花香，让人感到一种说不出的安宁与惬意。',
      after: '九点多。楼下早餐店的油烟味顺着窗缝钻进来。她把昨天的外卖盒扔进垃圾桶，桶满了，她又拎出来，换了个袋子。'
    }
  },
  {
    label: '控制修辞密度',
    rule: '比喻/拟人/通感每 500 字最多 1 处；连续 2 段不得都含比喻；叙事段禁止修辞；修辞必须和情节强度匹配，日常段落用白描，关键转折才用修辞',
    demo: {
      before: '雨水像断了线的珍珠，噼里啪啦地打在窗户上。风像一双无形的手，不停地摇晃着窗框。空气中弥漫着潮湿的泥土气息，像大地在深深地呼吸。',
      after: '下雨了。雨不大，打在铁皮棚顶上叮叮当当的。她关了窗，继续削苹果。刀子不快了，削出来的皮断断续续的。'
    }
  },
  {
    label: '词汇意外性',
    rule: '叙述中须掺入具体的、不常见的细节词汇（品牌名、方言词、俗语、数字、专业术语），避免全篇使用"安全的"通用词；人物内心独白可以出现粗糙的、不优美的念头',
    demo: {
      before: '桌上放着一杯温热的茶，旁边是一本翻开的书籍。窗外的景色宜人，让人心旷神怡。',
      after: '桌上搁着半杯凉透的铁观音，茶渍糊了杯壁。旁边是上个月从多抓鱼买的二手《百年孤独》，才看到第三章就看不下去了，夹了张超市小票当书签。'
    }
  },
  {
    label: '段落节奏变化',
    rule: '段落长度须有起伏：混合长段、短句、碎片句和单句段，禁止每段字数接近、禁止段段「总-分-总」；段落内部结构要打散，有的段只写动作，有的段只写环境，有的段只有对话',
    demo: {
      before: '她走进房间，环顾四周。房间里很安静，只有窗外的风声。她坐下来，开始思考接下来该怎么办。\n\n他站在门口，看着她的背影。他知道她在想什么，但他不知道该如何开口。最终他还是选择了沉默。',
      after: '她推门进去。\n\n安静。窗外有风，把窗帘吹成一个鼓包又塌下来，反复。她在唯一那把椅子上坐了很久，久到腿麻，久到窗帘不动了。风停了。\n\n他就靠在门框上。'
    }
  },
  {
    label: '叙述温度起伏',
    rule: '情感浓度必须波动：写完一段高情感密度的内容后，紧接至少一段冷叙述（纯动作/纯环境/纯事务）；禁止全篇保持同一情感温度；紧张段后加入日常琐碎段降压',
    demo: {
      before: '他的目光深邃而温柔，仿佛能穿透她所有的防备。她的心剧烈地跳动着，一种从未有过的感觉在胸腔中蔓延开来。这一刻，她觉得整个世界都安静了下来。\n\n她转过身，泪水模糊了视线。那些被她压抑了许久的情感，终于如潮水般涌了出来。',
      after: '他看了她一眼。那一眼的时间很短。\n\n她去厨房倒了杯水，站在灶台边喝。水龙头没关紧，一滴一滴往下掉。她拧了一下，还是滴。算了。\n\n客厅里他在翻一本旧杂志，没翻几页就放下了。'
    }
  },
  {
    label: '打破完美感',
    rule: '允许并鼓励"不完美"的写法：未说完的话用省略号断掉、叙述中途岔开话题、角色的想法前后矛盾、用"好像""大概""忘了"等模糊词代替精确描写',
    demo: {
      before: '她清晰地记得那天的每一个细节：他穿着白色的衬衫，阳光照在他的侧脸上，风吹起他额前的头发。那是她见过的最美好的画面。',
      after: '那天他好像穿的白衬衫，也可能不是白的，反正是浅色。风挺大的。其他的她记不太清了，就记得他好像说了句什么，她没听见，风太大了。'
    }
  }
]

export const DEFAULT_ANTI_AI_RULE_PRESETS: AntiAiPreset[] = [
  ...SURFACE_ANTI_AI_PRESETS,
  ...DEEP_ANTI_AI_PRESETS
]

// ---------------------------------------------------------------------------
//  CRUD
// ---------------------------------------------------------------------------

export function getAntiAiRules(workId: number): string[] {
  const row = coreSettingDAO.getByType(workId, ANTI_AI_RULES_TYPE)
  if (!row?.content?.trim()) return []
  try {
    const parsed = JSON.parse(row.content) as unknown
    return Array.isArray(parsed) ? parsed.filter(r => typeof r === 'string' && r.trim()) : []
  } catch {
    return row.content.split('\n').map(s => s.trim()).filter(Boolean)
  }
}

export function setAntiAiRules(workId: number, rules: string[]): string[] {
  const cleaned = rules.map(r => r.trim()).filter(Boolean)
  coreSettingDAO.upsert(workId, ANTI_AI_RULES_TYPE, JSON.stringify(cleaned))
  return cleaned
}

export function appendAntiAiRules(workId: number, newRules: string[]): string[] {
  const existing = getAntiAiRules(workId)
  const merged = [...existing]
  for (const r of newRules) {
    const t = r.trim()
    if (t && !merged.includes(t)) merged.push(t)
  }
  return setAntiAiRules(workId, merged)
}

// ---------------------------------------------------------------------------
//  自定义预设 CRUD（per-work，存储在 core_settings，type = 'custom_anti_ai_presets'）
// ---------------------------------------------------------------------------

const CUSTOM_PRESETS_TYPE = 'custom_anti_ai_presets'

export function getCustomAntiAiPresets(workId: number): AntiAiPreset[] {
  const row = coreSettingDAO.getByType(workId, CUSTOM_PRESETS_TYPE)
  if (!row?.content?.trim()) return []
  try {
    const parsed = JSON.parse(row.content) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is AntiAiPreset => !!p && typeof p === 'object' && typeof (p as AntiAiPreset).label === 'string' && typeof (p as AntiAiPreset).rule === 'string'
    )
  } catch {
    return []
  }
}

export function setCustomAntiAiPresets(workId: number, presets: AntiAiPreset[]): AntiAiPreset[] {
  const cleaned = presets.filter(p => p.label.trim() && p.rule.trim()).map(p => ({
    label: p.label.trim(),
    rule: p.rule.trim(),
    ...(p.demo ? { demo: { before: p.demo.before.trim(), after: p.demo.after.trim() } } : {})
  }))
  coreSettingDAO.upsert(workId, CUSTOM_PRESETS_TYPE, JSON.stringify(cleaned))
  return cleaned
}

/**
 * 获取作品可用的全部预设：内置 + 自定义。
 * 自定义预设排在后面，label 前加 [自定义] 标识。
 */
export function getAllAntiAiPresets(workId: number): { builtIn: AntiAiPreset[]; custom: AntiAiPreset[] } {
  return {
    builtIn: DEFAULT_ANTI_AI_RULE_PRESETS,
    custom: getCustomAntiAiPresets(workId)
  }
}

// ---------------------------------------------------------------------------
//  作品级参考文本（存储在 core_settings 中）
// ---------------------------------------------------------------------------

export function getWorkReferenceText(workId: number): string {
  const row = coreSettingDAO.getByType(workId, REFERENCE_TEXT_TYPE)
  return row?.content?.trim() ?? ''
}

export function setWorkReferenceText(workId: number, text: string): void {
  coreSettingDAO.upsert(workId, REFERENCE_TEXT_TYPE, text.slice(0, 5000))
}

// ---------------------------------------------------------------------------
//  Prompt 格式化
// ---------------------------------------------------------------------------

const EM_DASH_PATTERN = /——|—(?![\u4e00-\u9fff])/g

export function countEmDashes(content: string): number {
  return (content.match(EM_DASH_PATTERN) ?? []).length
}

/**
 * 移除正文中的破折号：换逗号（默认）或直接删除。
 * 先处理「——」再处理单「—」，并清理多余标点。
 */
export function stripEmDashes(content: string, mode: 'comma' | 'delete' = 'comma'): string {
  if (!content.trim()) return content

  let text = content
  if (mode === 'comma') {
    text = text.replace(/——/g, '，')
    text = text.replace(/—(?![\u4e00-\u9fff])/g, '，')
    text = text.replace(/，{2,}/g, '，')
    text = text.replace(/，\s*，/g, '，')
    text = text.replace(/，([。！？；、])/g, '$1')
    text = text.replace(/([。！？；])，/g, '$1')
  } else {
    text = text.replace(/——/g, '')
    text = text.replace(/—(?![\u4e00-\u9fff])/g, '')
  }
  return text
}

function rulesForbidEmDash(rules: string[]): boolean {
  return rules.some(r => /破折号|——/.test(r))
}

function demoConflictsWithRules(demo: { before: string; after: string }, rules: string[]): boolean {
  if (!rulesForbidEmDash(rules)) return false
  return EM_DASH_PATTERN.test(demo.before) || EM_DASH_PATTERN.test(demo.after)
}

const HUMAN_WRITING_META = [
  '【去AI痕迹——外部检测器最敏感的特征】',
  'A. 每段最多只能有 1 个中文句号“。”，连续动作、因果递进和并列描写用逗号串联，或直接换段。',
  'B. 禁止“不是A，而是B”“不是A，是B”“这不是A，这是B”句式，必须改成直接叙述、动作呈现或删掉前半句。',
  'C. 禁止把人物动作插入同一段对话中间，不写「“前半句。”人物动作，“后半句。”」；动作另起一段，完整台词单独成段。',
  'D. 禁止"电影镜头链"式描写：不要写"他转身→目光落在…上→嘴角微微上扬→缓缓开口"这类逐帧分镜。',
  '   用一句复合句概括动作，或省略中间过程直接写结果。',
  'E. 禁止书面连接词：然而、因此、此外、与此同时、不仅如此、尽管如此等。',
  '   直接删除或用口语词替代（"结果""谁知""这下"）。',
  'F. 禁止机械对话标注（"他说，""她问。"）——改为附带动作/神态/语气的标注，或省略标注。',
  'G. 禁止模板情感句（"心中涌起一股…""眼中闪过一丝…"）删除或改为具体动作。',
  'H. 禁止总结收束句（"这一刻他明白了…""或许这便是…"）直接删除。',
  'I. 词汇选择偏口语/低频/方言化：多用具象冷门词，少用标准书面语。',
  '   叙述中每 300 字至少掺入 1 个具体的、不常见的细节词。',
  '目标：写出来的东西像一个赶稿的人类作者写的有精彩有糙段，有灵光一闪也有平铺直叙。'
].join('\n')

/**
 * 将规则列表格式化为去 AI 味 system 文本（含示范对与底层模式）。
 */
export function formatAntiAiRulesFromList(rules: string[]): string {
  if (rules.length === 0) return ''

  const lines: string[] = [
    '【去AI味强制规则】',
    '以下规则用于消除机器写作痕迹，违反任一条视为不合格输出：',
    ''
  ]

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    lines.push(`${i + 1}. ${rule}`)
    const preset = DEFAULT_ANTI_AI_RULE_PRESETS.find(p => p.rule === rule)
    if (preset?.demo && !demoConflictsWithRules(preset.demo, rules)) {
      lines.push(`   ✗ AI 腔：${preset.demo.before}`)
      lines.push(`   ✓ 人味：${preset.demo.after}`)
    }
  }

  const hasDeepRules = rules.some(r =>
    /突发|白开水|修辞密度|词汇意外|温度起伏|完美感|句长/.test(r)
  )
  if (hasDeepRules) {
    lines.push('')
    lines.push(HUMAN_WRITING_META)
  }

  lines.push('')
  lines.push('生成前自检：逐条核对上述规则，任一违规则重写该句后再输出全文。')

  return lines.join('\n')
}

/** 无作品上下文时使用的内置去 AI 规则（AI 实验室等） */
export function formatBuiltinAntiAiRulesForPrompt(): string {
  const rules = DEFAULT_ANTI_AI_RULE_PRESETS.map(p => p.rule)
  return formatAntiAiRulesFromList(rules)
}

const STYLE_CONFLICT_RULE_PATTERN = /怪诞|品牌名|方言|粗话|跑题|词汇意外性|不属于这个语境/
const BODY_GENERATION_LIGHT_RULE_PATTERN = /连接词|模板化|模板情感|解释腔|总结式段尾|口语化|电影镜头链|镜头调度|机械对话标注|裸对话标注|裸标注|句号|不是.*(?:而是|是)|对话.*动作|动作.*对话/

function pickBodyGenerationRules(rules: string[]): string[] {
  const picked = rules.filter(rule =>
    BODY_GENERATION_LIGHT_RULE_PATTERN.test(rule) &&
    !STYLE_CONFLICT_RULE_PATTERN.test(rule)
  )
  return picked
}

function shouldScopeAntiAiRulesForStep(step: string | undefined): boolean {
  if (!step) return false
  return (
    step === 'body_generation' ||
    step === 'body_style_rewrite' ||
    step === 'quality_diagnosis_ai' ||
    step === 'quality_apply_fixes' ||
    step === 'critique_apply_fixes'
  )
}

function scopeAntiAiRulesForStep(workId: number, rules: string[], step: string | undefined): string[] {
  if (!step || !hasStyleReferenceText(workId)) return rules
  if (!shouldScopeAntiAiRulesForStep(step)) return rules
  if (step === 'body_generation') return pickBodyGenerationRules(rules)
  if (!rules.length) return rules
  return rules.filter(rule => !STYLE_CONFLICT_RULE_PATTERN.test(rule))
}

/**
 * 格式化去 AI 味规则 + 正面示范 (few-shot) + 人类写作底层模式到 system prompt。
 * 规则放在 system prompt 最末尾（见 context-budget priority），以覆盖前面的 few-shot 示范。
 *
 * body_generation 步骤：若作品未配置 per-work 规则，自动 fallback 到基于朱雀实验结论
 * 的轻量级去 AI 味指引（HUMAN_WRITING_META），确保正文生成始终有去 AI 味兜底。
 */
export function formatAntiAiRulesForPrompt(workId: number, step?: string): string {
  const scoped = scopeAntiAiRulesForStep(workId, getAntiAiRules(workId), step)
  const formatted = formatAntiAiRulesFromList(scoped)
  if (formatted) return formatted

  if (step === 'body_generation') {
    return HUMAN_WRITING_META
  }
  return ''
}

/**
 * 按文风 ID 收集 few-shot（实验室 / 无作品绑定场景）。
 * 优先级：reference_text → sample_text
 */
export function buildStyleFewShotForStyle(styleId: number): string {
  const style = writingStyleDAO.getById(styleId)
  if (!style) return ''

  const parts: string[] = []
  let budget = MAX_FEWSHOT_CHARS

  if (style.reference_text?.trim()) {
    const ref = style.reference_text.trim().slice(0, MAX_STYLE_REFERENCE_TEXT_CHARS)
    parts.push('【目标范文】\n' + ref)
  }

  if (style.sample_text?.trim() && budget > 200) {
    const sample = style.sample_text.trim().slice(0, Math.min(300, budget))
    parts.push(`【文风参考样例 · ${style.name}】\n${sample}`)
    budget -= sample.length
  }

  if (parts.length === 0) return ''
  return parts.join('\n\n')
}

export interface AntiAiRuleViolation {
  rule: string
  detail: string
  count?: number
}

function calcSentenceLengthCV(text: string): number {
  const sentences = text.split(/[。！？!?…]+/).filter(s => s.trim().length > 0)
  if (sentences.length < 3) return 1
  const lengths = sentences.map(s => s.replace(/\s/g, '').length)
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length
  if (avg === 0) return 0
  const variance = lengths.reduce((s, l) => s + Math.pow(l - avg, 2), 0) / lengths.length
  return Math.sqrt(variance) / avg
}

function countMetaphors(text: string): number {
  const patterns = [
    /像[^。！？\n]{2,20}(?:一样|似的|般)/g,
    /如同[^。！？\n]{2,20}/g,
    /仿佛[^。！？\n]{2,20}/g,
    /宛如[^。！？\n]{2,20}/g,
    /好似[^。！？\n]{2,20}/g,
    /犹如[^。！？\n]{2,20}/g,
    /像是[^。！？\n]{2,20}/g,
    /似[^。！？\n]{0,15}(?:的|般)/g
  ]
  let count = 0
  for (const p of patterns) {
    count += (text.match(p) ?? []).length
  }
  return count
}

function countShortSentences(text: string): { total: number; short: number; ratio: number } {
  const sentences = text.split(/[。！？!?…]+/).filter(s => s.trim().length > 0)
  const total = sentences.length
  const short = sentences.filter(s => s.replace(/\s/g, '').length <= 6).length
  return { total, short, ratio: total > 0 ? short / total : 0 }
}

/** 检测正文是否违反已配置的去 AI 味规则（生成后校验用） */
export function checkAntiAiRuleViolations(workId: number, content: string): AntiAiRuleViolation[] {
  const rules = getAntiAiRules(workId)
  if (!rules.length || !content.trim()) return []

  const violations: AntiAiRuleViolation[] = []

  if (rulesForbidEmDash(rules)) {
    const count = countEmDashes(content)
    if (count > 0) {
      violations.push({
        rule: '禁止使用破折号',
        detail: `检测到 ${count} 处破折号（—— / —）`,
        count
      })
    }
  }

  for (const rule of rules) {
    if (/然而|因此|总的来说/.test(rule)) {
      for (const word of ['然而', '因此', '总的来说', '与此同时', '不仅如此']) {
        const n = (content.match(new RegExp(word, 'g')) ?? []).length
        if (n > 1) {
          violations.push({ rule, detail: `「${word}」出现 ${n} 次（规则要求同词整章最多 1 次）`, count: n })
        }
      }
    }
    if (/心中涌起一股|眼中闪过一丝/.test(rule)) {
      for (const pat of ['心中涌起一股', '眼中闪过一丝', '嘴角微微上扬']) {
        const n = (content.match(new RegExp(pat, 'g')) ?? []).length
        if (n > 0) {
          violations.push({ rule, detail: `含模板句「${pat}」× ${n}`, count: n })
        }
      }
    }
    if (/电影镜头链|镜头调度/.test(rule)) {
      const filmPatterns: [RegExp, string][] = [
        [/(?:目光|视线|眼神)(?:落在|扫过|越过|移到|停在|掠过).{0,15}上/g, '目光落在…上'],
        [/嘴角微微(?:上扬|勾起|一弯)/g, '嘴角微微上扬'],
        [/缓缓(?:开口|站起身|回过头|转过身|抬起头)/g, '缓缓…'],
        [/脚步(?:一顿|顿了顿|微微一顿)/g, '脚步一顿'],
      ]
      for (const [pat, label] of filmPatterns) {
        const n = (content.match(pat) ?? []).length
        if (n > 0) {
          violations.push({ rule, detail: `含电影镜头链「${label}」× ${n}`, count: n })
        }
      }
    }

    if (/句长突发|突发性/.test(rule)) {
      const cv = calcSentenceLengthCV(content)
      if (cv < 0.4) {
        violations.push({
          rule,
          detail: `句长变异系数仅 ${cv.toFixed(2)}（低于 0.4 说明句子长度过于均匀，人类写作通常 > 0.6）`,
          count: Math.round(cv * 100)
        })
      }
      const ss = countShortSentences(content)
      if (ss.total >= 10 && ss.ratio < 0.1) {
        violations.push({
          rule,
          detail: `碎片短句（≤6字）仅占 ${Math.round(ss.ratio * 100)}%（${ss.short}/${ss.total}句），要求至少 20%`,
          count: ss.short
        })
      }
    }

    if (/机械对话标注|裸对话标注|裸标注/.test(rule)) {
      const mechPatterns: RegExp[] = [
        /[""\u201d](?:他|她)说[，。！？]/g,
        /[""\u201d](?:他|她)问[，。！？]/g,
        /[""\u201d][\u4e00-\u9fff]{1,4}说[，。！？]/g,
        /[""\u201d][\u4e00-\u9fff]{1,4}问[，。！？]/g,
      ]
      let mechCount = 0
      const mechExamples: string[] = []
      for (const pat of mechPatterns) {
        const matches = content.match(pat) ?? []
        for (const m of matches) {
          const core = m.replace(/^[""\u201d]/, '').replace(/[，。！？]$/, '')
          if (core.endsWith('说道') || core.endsWith('问道') || core.endsWith('道')) continue
          if (/(?:笑|冷|怒|急|沉声|轻声|低声|大声|淡淡|缓缓|森然|冷冷|温声|厉声)/.test(core)) continue
          mechCount++
          if (mechExamples.length < 3) mechExamples.push(m.slice(0, 15))
        }
      }
      if (mechCount > 0) {
        violations.push({
          rule,
          detail: `含机械对话标注 ${mechCount} 处（${mechExamples.join('、')}），应附带动作/神态/语气描写`,
          count: mechCount
        })
      }
    }

    if (/不是.*(?:而是|是)/.test(rule)) {
      const stripped = stripForbiddenNotIsPatterns(content)
      if (stripped !== content) {
        const removed = content.length - stripped.length
        violations.push({ rule, detail: `正则命中并可删除“不是…是/而是”句式，预计删除 ${removed} 个字符`, count: removed })
      }
    }

    if (/每段.*句号|句号.*每段|一段.*句号/.test(rule)) {
      const badCount = content.split(/\n+/).filter(line => (line.match(/。/g) ?? []).length > 1).length
      if (badCount > 0) {
        violations.push({ rule, detail: `有 ${badCount} 段包含超过 1 个句号`, count: badCount })
      }
    }

    if (/对话.*动作|动作.*对话|人物动作插入/.test(rule)) {
      const n = (content.match(/["“「][^"”」\n]{1,80}[。！？]["”」][^\n"“「]{1,40}[，,]["“「]/g) ?? []).length
      if (n > 0) {
        violations.push({ rule, detail: `含动作插入对话中间的夹心结构 × ${n}`, count: n })
      }
    }

    if (/短促强否定/.test(rule)) {
      const n = (content.match(/，没(?:有)?[\u4e00-\u9fa5]{1,2}[。！？]/g) ?? []).length
      if (n > 0) {
        violations.push({ rule, detail: `含短句强否定收尾 × ${n}`, count: n })
      }
    }

    if (/精确度量/.test(rule)) {
      const n = (content.match(/(?:\d+|[一二三四五六七八九十百千万零]+)(?:度|厘米|毫米|米)/g) ?? []).length
      if (n > 0) {
        violations.push({ rule, detail: `含机械精确物理量词 × ${n}`, count: n })
      }
    }

    if (/形容词回环|很Y，Y得连|语气很平|声音很平/.test(rule)) {
      const stripped = stripDeterministicAiPatterns(content)
      if (stripped !== content) {
        violations.push({
          rule,
          detail: '含"X很Y，Y得连Z都W"或"声音/语气很平/稳"等假装冷静的标签句，应直接删除',
          count: 1
        })
      }
    }

    if (/修辞密度|比喻/.test(rule) && !/陈词/.test(rule)) {
      const metaphors = countMetaphors(content)
      const totalChars = content.replace(/\s/g, '').length
      const per500 = totalChars > 0 ? (metaphors / (totalChars / 500)) : 0
      if (per500 > 1.5) {
        violations.push({
          rule,
          detail: `修辞/比喻密度约 ${per500.toFixed(1)} 处/500字（规则要求≤1处/500字）`,
          count: metaphors
        })
      }
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
//  收藏佳句 / 文风样例 / 参考范文 → few-shot 示范
// ---------------------------------------------------------------------------

const MAX_FEWSHOT_CHARS = 4000

/**
 * 收集 few-shot 示范文本，按优先级注入：
 *  1. style.reference_text（全量，≤15000字）— 目标文风范文，最核心的风格信号
 *  2. work_reference_text  (≤600字) — 作品专属参考
 *  3. style.sample_text + favorites（短摘）— 补充示范
 */
export function buildStyleFewShot(workId: number): string {
  const parts: string[] = []
  let budget = MAX_FEWSHOT_CHARS

  const styleId = writingStyleDAO.getWorkStyleId(workId)
  const style = styleId ? writingStyleDAO.getById(styleId) : undefined

  if (style?.reference_text?.trim()) {
    const ref = style.reference_text.trim().slice(0, MAX_STYLE_REFERENCE_TEXT_CHARS)
    parts.push(
      '【目标范文 - 正文的用词、句式、节奏、对话密度必须与此范文保持一致】\n' + ref
    )
  }

  const workRef = getWorkReferenceText(workId)
  if (workRef && budget > 200) {
    const ref = workRef.slice(0, Math.min(600, budget))
    parts.push('【作品专属参考范文】\n' + ref)
    budget -= ref.length
  }

  if (style?.sample_text?.trim() && budget > 200) {
    const sample = style.sample_text.trim().slice(0, Math.min(300, budget))
    parts.push(`【文风参考样例 · ${style.name}】\n${sample}`)
    budget -= sample.length
  }

  const favorites = aiFavoriteDAO.listByWork(workId)
    .filter(f => f.source_step === 'body_generation' && f.content.trim())
  if (favorites.length > 0 && budget > 200) {
    const excerpts: string[] = []
    for (const fav of favorites.slice(0, 2)) {
      const text = fav.content.trim()
      const excerpt = text.length > 220 ? text.slice(0, 220) + '…' : text
      if (budget - excerpt.length < 0) break
      excerpts.push(excerpt)
      budget -= excerpt.length
    }
    if (excerpts.length) {
      parts.push(
        '【作者收藏佳句 - 生成时在用词、句式、节奏上向这些样例靠拢】',
        ...excerpts.map((e, i) => `--- 佳句${i + 1} ---\n${e}`)
      )
    }
  }

  if (parts.length === 0) return ''
  return parts.join('\n\n')
}

/** 作品绑定的文风是否配置了参考范文（目标范文） */
export function hasStyleReferenceText(workId: number): boolean {
  const styleId = writingStyleDAO.getWorkStyleId(workId)
  const style = styleId ? writingStyleDAO.getById(styleId) : undefined
  return !!style?.reference_text?.trim()
}

// ---------------------------------------------------------------------------
//  Anti-AI 写作人设：从参考文本自动推断
// ---------------------------------------------------------------------------

/**
 * 用启发式检测器筛选范文段落：只保留「人味高」（低 AI 分）的段落，
 * 让 persona 仅由真正像人写的范本推导，形成正反馈。范文若本身偏 AI，
 * 会被过滤掉，避免让模型学 AI 的困惑度分布。
 */
function filterHumanLikeParagraphs(referenceText: string): string {
  const paragraphs = referenceText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  if (paragraphs.length <= 1) return referenceText.trim()
  const docMetrics = computeDocMetrics(referenceText)
  // 人味门槛：启发式分 <= 此值才视为「像人写的」范本
  const HUMAN_SCORE_CEILING = 60
  const kept = paragraphs.filter(p => {
    if (p.replace(/\s/g, '').length < 20) return true // 短段落不判，保留结构
    return computeHeuristicAiScore(p, docMetrics, 52) <= HUMAN_SCORE_CEILING
  })
  // 若过滤后所剩无几（范文整体偏 AI），退回原文，避免 persona 失效
  const keptChars = kept.reduce((s, p) => s + p.replace(/\s/g, '').length, 0)
  if (keptChars < 80) return referenceText.trim()
  return kept.join('\n\n')
}

/**
 * 分析参考文本的统计特征，生成一段简洁的写作人设描述。
 * 注入 system prompt 最前面，让模型以此人设写作。
 * 范文会先过检测器筛选，仅保留人味高的段落。
 */
export function buildAntiAiPersona(referenceText: string): string {
  if (!referenceText.trim() || referenceText.length < 100) return ''

  const filtered = filterHumanLikeParagraphs(referenceText)
  if (filtered.length < 100) return ''

  const sentences = filtered
    .split(/[。！？!?…]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
  if (sentences.length < 5) return ''

  const lengths = sentences.map(s => s.replace(/\s/g, '').length)
  const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length

  const metaphorCount = countMetaphors(filtered)
  const totalChars = filtered.replace(/\s/g, '').length
  const metaphorPer500 = totalChars > 0 ? metaphorCount / (totalChars / 500) : 0

  const dialogueMatches = filtered.match(/[「""][^「""」]*[」""]/g) ?? []
  const dialogueChars = dialogueMatches.reduce((sum, m) => sum + m.length, 0)
  const dialogueRatio = totalChars > 0 ? dialogueChars / totalChars : 0

  const paragraphs = filtered.split(/\n\s*\n/).filter(p => p.trim())
  const shortParas = paragraphs.filter(p => p.trim().length < 30).length
  const shortParaRatio = paragraphs.length > 0 ? shortParas / paragraphs.length : 0

  const traits: string[] = []

  if (avgLen < 15) traits.push('句子偏短，节奏快')
  else if (avgLen > 30) traits.push('句子偏长，叙述细密')
  else traits.push('句长适中')

  if (metaphorPer500 < 0.3) traits.push('几乎不用比喻，以白描叙事为主')
  else if (metaphorPer500 < 1) traits.push('偶尔用比喻，但不追求文采')
  else traits.push('修辞较多')

  if (dialogueRatio > 0.4) traits.push('对话占比大，场景靠对话推进')
  else if (dialogueRatio > 0.2) traits.push('对话与叙述穿插')
  else traits.push('以叙述为主，对话较少')

  if (shortParaRatio > 0.3) traits.push('经常使用短段落和碎片段')
  else traits.push('段落长度正常')

  traits.push('允许重复用词，不刻意追求词汇多样性')
  traits.push('经常交代不重要的背景细节和日常琐碎')

  return [
    '【你的写作人设】',
    `你是一个${traits.slice(0, 2).join('、')}的网文作者。`,
    `写作特点：${traits.join('；')}。`,
    '你不是散文诗人，不追求句句精致。你赶稿，写得快，有好段也有糙段。'
  ].join('\n')
}

/**
 * 为指定作品构建完整的 anti-AI 人设（优先用文风 reference_text，其次用作品级参考文本）
 */
export function buildAntiAiPersonaForWork(workId: number): string {
  const styleId = writingStyleDAO.getWorkStyleId(workId)
  if (styleId) {
    const style = writingStyleDAO.getById(styleId)
    if (style?.reference_text?.trim()) {
      return buildAntiAiPersona(style.reference_text)
    }
  }
  const workRef = getWorkReferenceText(workId)
  if (workRef) {
    return buildAntiAiPersona(workRef)
  }
  return ''
}

// ---------------------------------------------------------------------------
//  稿件优化：纯文风 system prompt（Step 2 去 AI 味重写）
// ---------------------------------------------------------------------------

export const STYLE_REWRITE_INSTRUCTION = [
  '你是资深网文编辑。核心任务是降低AIGC特征。',
  '',
  '核心目标：不改剧情与人设，不重排主事件，只改确实生硬的表达。',
  '',
  '★★★ 最高优先级——外部检测器最敏感的AI指纹（必须首先消除）：',
  '',
  '【致命】禁止"电影镜头链"式描写：',
  '  禁止连续的逐帧动作分镜（"他转身→目光落在…上→嘴角微微上扬→缓缓开口"）。',
  '  禁止"目光落在/扫过/越过…上"的句式，改为"看了眼…"或直接省略。',
  '  禁止"嘴角微微上扬/微勾"、"脚步顿了顿"、"缓缓回过头"等镜头调度词。',
  '',
  '【高危】消灭书面连接词：',
  '  禁用：然而、因此、此外、与此同时、不仅如此、尽管如此、值得注意的是、总而言之。',
  '  替代：直接删除，或改为口语词（"结果""谁知""这下""得了"）。',
  '',
  '【中危】消灭机械对话标注：',
  '  禁止"他说，""她问。""XX说。"等裸标注，必须附带动作/神态/语气。',
  '  ✗ "走吧。"他说。→ ✓ "走吧。"他把背包往肩上一甩。',
  '  ✗ "真的？"她问。→ ✓ "真的？"她皱了下眉。',
  '  也可省略标注让上下文暗示说话人。',
  '',
  '【中危】消灭模板情感句和总结收束句：',
  '  禁用："心中涌起一股…""眼中闪过一丝…""一股…涌上心头"。',
  '  禁用段尾/章尾总结："这一刻他明白了…""或许这便是…""对于…而言…"。',
  '',
  '【中危】消灭"短句强否定"收尾：',
  '  禁用：动作句后接逗号加"没/没有+动词"的短促结尾。',
  '  ✗ "碎瓷溅上脚踝，她没躲。" → ✓ "碎瓷溅上脚踝，她连躲的动作都没有。"',
  '  ✗ "老太太端起茶杯，没喝。" → ✓ "老太太端起茶杯看了看，又搁回了桌上。"',
  '  【如何改更有人味】人类不会机械地重复"没说话"制造冷酷感，而会用具体的转移注意力的动作（低头抿水、视线错开、拨弄物件）来填补沉默的张力。',
  '',
  '【低危】消灭机械精确度量：',
  '  禁用：日常描写中滥用具体的度数、厘米/毫米等物理量词。',
  '  ✗ "向外旋开15度，上方三毫米处" → ✓ "旋开一条窄缝，稍微偏上一点"。',
  '  【如何改更有人味】将精确数字转化为感性模糊的状态描述（如"震颤两次"改为"眼底微微一颤"）。',
  '',
  '其他重写规则：',
  '1.禁用高频破折号：全篇"——"控制在1-2处以内',
  '2.保留冗余和啰嗦：人类写作有"废话"，动作描写允许拆碎、重复、不精简',
  '3.保持口语粗糙感：使用口语/俗语/方言化用词，不追求每个词的文学性',
  '4.心理活动散漫化：允许"想到哪说到哪"，不归纳为整齐的排比或连问',
  '5.避免对称/并列结构：不使用"A着B，C着D"这种过于工整的句式。要求：打破句式的对称性，恢复人类讲话时不对称的自然感。',
  '6.引入"断裂感"：每500字至少有一处叙事断裂——用连词合并部分原子短句（电报式短句），消除机器人一样死板的动作切分。',
  '7.质量不均匀原则：刻意让某些段落"写得差"——描写粗糙、像流水账，与精写段落形成对比',
  '8.词汇选择偏口语/低频/方言化：多用具象冷门词替代标准书面语',
  '',
  '【章末钩子例外】',
  '若 user prompt 中包含"章末留钩"或"章末钩子"相关待改进项，对最后 300-500 字允许超越"不改剧情"限制：',
  '可重组结尾节奏、在高张力处截断、添加悬念暗示句、删除平淡收束。前文不受影响。',
  '',
  '只输出重写后的正文，不要解释。'
].join('\n')

/** 稿件优化 user prompt：质量待改项 + 初稿 + 目标字数约束（字数放末尾利用近因效应） */
export function buildStyleRewriteUserPrompt(
  content: string,
  wordTarget?: number,
  qualityHints?: string
): string {
  const trimmed = content.trim()
  const parts: string[] = []
  if (qualityHints?.trim()) {
    parts.push(qualityHints.trim())
  }
  parts.push('【以下是需要重写的初稿】', trimmed)
  if (wordTarget && wordTarget > 0) {
    const { min, max } = bodyWordCountBounds(wordTarget)
    parts.push(
      `【字数硬性约束】重写后正文必须控制在约 ${wordTarget} 字（±10%，即 ${min}–${max} 字）。可删减冗余描写以达到字数要求。`
    )
  }
  return parts.join('\n\n')
}

/**
 * 为稿件优化（Step 2）构建完整 system prompt。
 * 注入顺序（与正文生成对齐）：
 *  1. 范文核心指令（有范文时）
 *  2. 重写指令
 *  3. 写作人设（从范文推断的统计特征）
 *  4. 文风模板
 *  5. 参考范文（few-shot）
 *  6. （可选）去 AI 味规则
 */
export function buildStyleRewriteSystemPrompt(workId: number): string {
  const parts: string[] = []

  const hasRef = hasStyleReferenceText(workId)
  if (hasRef) {
    const coreDirective = STYLE_CORE_DIRECTIVE.trim()
    if (coreDirective) parts.push(coreDirective)
  }

  parts.push(STYLE_REWRITE_INSTRUCTION)

  if (hasRef) {
    const persona = buildAntiAiPersonaForWork(workId)
    if (persona) parts.push(persona)
  }

  const styleId = writingStyleDAO.getWorkStyleId(workId)
  const style = styleId ? writingStyleDAO.getById(styleId) : undefined

  if (style?.prompt_template?.trim()) {
    parts.push(style.prompt_template.trim())
  }

  const fewShot = buildStyleFewShot(workId)
  if (fewShot) parts.push(fewShot)

  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
//  AI 诊断：文风 + 去 AI 规则上下文（不含重写/生成指令）
// ---------------------------------------------------------------------------

/**
 * 为 AI 质量诊断构建文风上下文。
 * 包含：文风 prompt 模板、参考范文（全量）、去 AI 规则。
 * 不含生成/重写指令——诊断只需要知道"目标是什么"，不需要"怎么写"。
 */
export function buildStyleDiagnosisContext(workId: number): string {
  const parts: string[] = []
  const hasRef = hasStyleReferenceText(workId)

  if (hasRef) {
    parts.push([
      '【诊断文风基准 - 去 AI 痕迹的修改建议必须遵循此标准】',
      '下方【目标范文】是唯一的文笔参照。所有「→ 建议改为」的改写示例，必须严格模仿范文的用词习惯、句式长短、叙述节奏、对话密度和信息分布。',
      '禁止给出「更文学」「更优美」「更流畅」但仍是 AI 腔的通用替代句；改完后的句子应像范文作者亲笔写的。'
    ].join('\n'))
  }

  const styleId = writingStyleDAO.getWorkStyleId(workId)
  const style = styleId ? writingStyleDAO.getById(styleId) : undefined

  if (style?.prompt_template?.trim()) {
    parts.push('【目标文风要求】\n' + style.prompt_template.trim())
  }

  const fewShot = buildStyleFewShot(workId)
  if (fewShot) parts.push(fewShot)

  const antiAiRules = formatAntiAiRulesForPrompt(workId, 'quality_diagnosis_ai')
  if (antiAiRules) parts.push(antiAiRules)

  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
//  AI 痕迹 → 建议规则
// ---------------------------------------------------------------------------

export function suggestRulesFromAiTrace(issues: AiTraceIssue[]): string[] {
  const rules: string[] = []
  for (const issue of issues) {
    if (issue.type === 'film_shot_chain') {
      const preset = SURFACE_ANTI_AI_PRESETS.find(p => p.label === '禁电影镜头链')
      if (preset) rules.push(preset.rule)
      else rules.push('禁止"电影镜头链"式描写：不要逐帧写动作（"目光落在→嘴角上扬→缓缓开口"），用一句复合句概括或省略中间过程')
    } else if (issue.type === 'connector' && issue.examples[0]) {
      rules.push(`避免过度使用连接词「${issue.examples[0]}」，同词整章不超过 1 次`)
    } else if (issue.type === 'template' && /不是|而是/.test(issue.label)) {
      rules.push('禁止“不是A，而是B”“不是A，是B”“这不是A，这是B”句式，必须改成直接叙述、动作呈现或删掉前半句')
    } else if (issue.type === 'template' && issue.examples[0]) {
      rules.push(`禁止使用模板化表达「${issue.examples[0]}」及同类 AI 腔句式`)
    } else if (issue.type === 'closure_summary') {
      const preset = SURFACE_ANTI_AI_PRESETS.find(p => p.label === '禁总结式段尾')
      if (preset) rules.push(preset.rule)
    } else if (issue.type === 'structure') {
      rules.push('段落长度须有明显变化，混入短句、碎片句和单句段，避免各段字数接近')
    } else if (issue.type === 'metaphor_density') {
      const preset = DEEP_ANTI_AI_PRESETS.find(p => p.label === '控制修辞密度')
      if (preset) rules.push(preset.rule)
    } else if (issue.type === 'low_burstiness' || issue.type === 'no_short_sentences') {
      const preset = DEEP_ANTI_AI_PRESETS.find(p => p.label === '句长突发性')
      if (preset) rules.push(preset.rule)
    } else if (issue.type === 'escalated_adjective_echo') {
      const preset = SURFACE_ANTI_AI_PRESETS.find(p => p.label === '禁形容词回环递进')
      if (preset) rules.push(preset.rule)
    } else if (issue.type === 'mechanical_dialogue_tag') {
      const preset = SURFACE_ANTI_AI_PRESETS.find(p => p.label === '禁机械对话标注')
      if (preset) rules.push(preset.rule)
    } else if (issue.type === 'multiple_periods_per_paragraph') {
      rules.push('每段最多只能有 1 个中文句号“。”，连续动作、因果递进和并列描写用逗号串联，或直接换段')
    } else if (issue.type === 'dialogue_action_sandwich') {
      rules.push('禁止把人物动作插入同一段对话中间，尤其不要写「“前半句。”人物动作，“后半句。”」；动作另起一段，完整台词单独成段')
    } else if (issue.type === 'emotional_saturation' || issue.type === 'no_emotional_rest') {
      const preset = DEEP_ANTI_AI_PRESETS.find(p => p.label === '叙述温度起伏')
      if (preset) rules.push(preset.rule)
      const restPreset = DEEP_ANTI_AI_PRESETS.find(p => p.label === '白开水段落')
      if (restPreset) rules.push(restPreset.rule)
    }
  }
  return [...new Set(rules)]
}
