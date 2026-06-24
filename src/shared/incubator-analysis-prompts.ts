import { INCUBATOR_SLOT_KEYS, INCUBATOR_SLOT_LABELS, type IncubatorSlotKey } from './incubator-slots'
import type { IncubatorCandidateSourceStep, IncubatorGateReport } from './incubator-types'

/** 反平庸硬约束（结构化分析类 prompt 共用） */
export const INCUBATOR_ANTI_MEDIOCRITY = [
  // '额外硬约束（必须遵守）：',
  // '1) 禁止以「误会解除、天降帮助、主角开挂、靠沟通化解一切」作为核心解法。',
  // '2) 每个方案必须写明「不可逆代价」：失败后将永久失去的关系、身份、能力或机会之一。',
  // '3) 每个方案必须包含 1 个「反常识但自洽」的设计点，并说明其合理性。',
  // '4) 冲突至少三段升级：轻压 → 重压 → 破局或崩盘，不得平铺直叙。',
  // '5) 若内容可替换到任意题材、缺乏专属记忆点，视为不合格，须重写。'
].join('\n')

export const INCUBATOR_AI_SCORE_SYSTEM = `你是顶级的网文主编与大纲审核专家。
请对提供的一组【候选变体/扩写方案】进行结构化五维打分（0-100制），严格根据其实际质量打分。

【评分维度定义】
- attractionScore: 吸引力（设定是否抓人、是否有强烈的阅读期待感）
- serializabilityScore: 连载潜力（设定是否有足够的内容扩展空间和可持续的看点）
- differentiationScore: 差异化（设定/系统/金手指是否足够新颖，反套路程度）
- conflictClosureScore: 冲突闭环（核心冲突是否有张力，敌对势力或目标是否明确）
- executabilityScore: 可执行性（核心元素是否自洽，是否能直接用于正文写作）

【输出要求】
必须且只能输出一个包含 scores 数组的 JSON 对象。禁止输出任何 Markdown 格式。
示例：
{"scores": [
  {"id": 1, "attractionScore": 85, "serializabilityScore": 80, "differentiationScore": 90, "conflictClosureScore": 82, "executabilityScore": 88, "rationale": "冲突张力强，设定新颖但连载潜力一般"},
  {"id": 2, "attractionScore": ...}
]}
注意：id 必须与输入中的 id 一一对应。`

/** 建议用户按此顺序填充槽位 / 运行分析 */
export const INCUBATOR_SLOT_FILL_ORDER: IncubatorSlotKey[] = [
  'premise',
  'core_conflict',
  'world_rules',
  'role_engine',
  'opening',
  'ending'
]

/** 各分析在生成时，应注入的已填槽位（链式约束） */
export const ANALYSIS_SLOT_ANCHORS: Partial<Record<string, IncubatorSlotKey[]>> = {
  premise: [],
  variants: ['premise'],
  expand: ['premise', 'core_conflict'],
  world_rules: ['premise', 'core_conflict', 'opening'],
  role_engine: ['premise', 'core_conflict', 'opening', 'world_rules'],
  rhythm_curve: ['premise', 'core_conflict', 'opening', 'world_rules', 'role_engine', 'ending'],
  ending: ['premise', 'core_conflict', 'world_rules', 'role_engine', 'opening'],
  diagnose: [...INCUBATOR_SLOT_KEYS],
  reverse: [...INCUBATOR_SLOT_KEYS],
  anchors: ['premise', 'core_conflict', 'opening'],
  benchmark: ['premise', 'core_conflict', 'opening'],
  tone: ['premise', 'core_conflict', 'opening', 'ending'],
  frontstory: ['premise', 'core_conflict', 'opening'],
  microinnovation: ['premise', 'core_conflict', 'world_rules']
}

export function buildSlotAnchorBlock(
  slots: Partial<Record<IncubatorSlotKey, string>>,
  anchorKeys?: IncubatorSlotKey[]
): string {
  const keys = anchorKeys ?? INCUBATOR_SLOT_KEYS
  const parts = keys
    .map(k => {
      const text = slots[k]?.trim()
      return text ? `## ${INCUBATOR_SLOT_LABELS[k]}\n${text}` : ''
    })
    .filter(Boolean)
  if (!parts.length) return ''
  return ['【已确认的主线槽位（须与下列内容保持一致，不得矛盾）】', ...parts].join('\n\n')
}

export function buildAnalysisUserPrompt(
  seed: string,
  slots: Partial<Record<IncubatorSlotKey, string>>,
  analysisKey: string,
  characters?: string[]
): string {
  const anchors = ANALYSIS_SLOT_ANCHORS[analysisKey]
  const block = buildSlotAnchorBlock(slots, anchors)
  const sections = [`【创作种子】\n${seed.trim()}`]
  if (block) sections.push(block)
  if (characters && characters.length > 0) {
    sections.push(`【可选择的角色名称库（正文与设定必须使用此库中已有角色，禁止自行臆造名字）】\n角色：${characters.join('、')}\n（注意：若本分析涉及人物名称，请务必优先且只能从上述已知角色名称中进行挑选和关联，禁止自行生成或编造新角色名字）`)
  } else {
    sections.push('【角色命名严格约束】\n涉及人物名称时，禁止自行臆造具体人名。主角请统一使用"男主"、"女主"指代，若需提及配角与反派请统一使用"张某"、"李某"、"王某"等泛化代称。')
  }
  return sections.join('\n\n')
}

const JSON_ONLY = '【严格约束】\n只输出一个纯 JSON 对象，禁止使用 Markdown 格式（不要使用代码块标签），禁止输出任何标题、解释或 JSON 结构外的文字。'

function cardExpandExample(fields: string): string {
  return `示例：{"versions":[{"title":"方案名","summary":"${fields}"}]}`
}

export const INCUBATOR_ANALYSIS_PROMPTS: Record<
  string,
  { label: string; step: string; system: string; cardFormat?: 'variants' | 'expand' | 'anchors'; slotTarget?: IncubatorSlotKey; sourceStep?: string }
> = {
  premise: {
    label: '主题前提',
    step: 'incubator_premise',
    cardFormat: 'expand',
    slotTarget: 'premise',
    sourceStep: 'premise_gen',
    system: [
      '你是顶级的网文故事策划师与主题架构大师。基于用户提供的【创作种子】，提炼 3 套截然不同且极具深度的【主题前提】方案。',
      '【核心理念】',
      '主题前提是整个故事的统领性命题——它回答"这个故事在论证什么"。核心冲突是主题的外化戏剧冲突，终局是主题的最终论证。没有主题前提的故事容易沦为情节堆砌。',
      '【输出要求】\n每套方案须包含以下字段：\n- title：极具概括力与吸引力的主题命名\n- summary：（400-600字）必须极其饱满、思想深刻，且明确标注以下4个核心结构点：\n  ① 主题命题：这个故事要论证的核心命题（如"绝对权力必然腐蚀最初良善的意图"），需说明其哲学深度与现实映射。\n  ② 命题两面性：正方论点（支持命题的情境与逻辑）与反方论点（质疑命题的情境与逻辑），展现思想的辩证张力。\n  ③ 情感内核：主题对读者情感的深层冲击机制（如代入感来源、情感共鸣点、价值观碰撞），需说明如何让读者在故事中自我投射。\n  ④ 主题外化路径：该主题最适合通过怎样的核心冲突来戏剧化呈现（需给出1-2个方向性建议，不展开细节，留给后续核心冲突槽）。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      '注意：summary 字段必须是一个完整的字符串，不要将其拆分为数组或多个字段。请使用 \\n 来换行。',
      cardExpandExample('①主题命题：...\\n②命题两面性：...\\n③情感内核：...\\n④主题外化路径：...')
    ].join('\n')
  },
  variants: {
    label: '变体探索',
    step: 'incubator_variants',
    cardFormat: 'variants',
    slotTarget: 'core_conflict',
    sourceStep: 'variants',
    system: [
      '你是顶级的网文故事结构策划师与脑洞拓展大师。基于用户提供的【创作种子】与已确认的【主题前提】，请彻底打破常规套路，进行极限发散，沿 6 个截然不同且极具颠覆性的创新维度，为故事寻找最硬核的【核心冲突】。',
      '【发散维度建议】',
      '请跳出常规，自由拓展至更硬核的维度，例如：物种形态跨越、极端社会/物理规则（如谎言成真、因果反转）、奇观体系融合、打破第四面墙、叙事诡计实验、极致的哲学与道德困境等。',
      '【强一致性警告】\n核心冲突必须是对主题前提的外化与戏剧化，严禁偏离主题命题的论证方向。',
      '【强一致性警告】\n核心冲突必须是对主题前提的外化与戏剧化，严禁偏离主题命题的论证方向。',
      '【强一致性警告】\n核心冲突必须是对主题前提的外化与戏剧化，严禁偏离主题命题的论证方向。',
      '【输出要求】\n每变体须包含以下字段：\n- title：极具网文吸引力与爆款潜质的悬念标题\n- dimension：你所发散的创新维度名称（需具想象力）\n- summary：（400-600字）必须极其饱满、细节丰富，且明确标注以下5个核心结构点：\n  ① 核心冲突：谁vs谁/某种绝对规则，争夺什么绝对不可妥协的事物（需具体到场景与细节）\n  ② 不可逆代价：主角为破局必须承受的、震撼读者的非传统代价（需说明代价带来的深远影响）\n  ③ 三段升级路径：起步 -> 质变 -> 终局的跃升与颠覆路线（每段需有具体的转折事件支撑）\n  ④ 反常识钩子：彻底打破读者预期的惊艳/奇葩设定（需解释其内在自洽的逻辑）\n  ⑤ 读者追读理由：直击多巴胺的爽点、猎奇心或极致的情感共鸣（需点明击中哪种深层心理）\n',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      '注意：summary 字段必须是一个完整的字符串，不要将其拆分为数组或多个字段。请使用 \\n 来换行。',
      '【JSON结构示例】\n{"variants":[{"title":"...","dimension":"...","summary":"①核心冲突：...\\n②不可逆代价：...\\n③三段升级路径：...\\n④反常识钩子：...\\n⑤读者追读理由：..."}]}'
    ].join('\n')
  },
  expand: {
    label: '开局扩写',
    step: 'incubator_expand',
    cardFormat: 'expand',
    slotTarget: 'opening',
    sourceStep: 'expand',
    system: [
      '你是顶级的网文故事结构策划师与开篇设计专家。基于用户已确定的【主题前提】与【核心冲突】，请进行深度推演，生成 3 条截然不同、互不重合的【开局设计】与前3章切入路径。',
      '【边界约束】\n开局设计只负责"前3章如何切入"——信息差构建、代入感、第一幕场景设计。不重复核心冲突的定义，不写中段翻转或高潮结局（那些留给终局槽）。',
      '【路径差异化要求】\n3条路径需分别锚定不同的开局切入点与爆款驱动力，例如：路径A可侧重"极致苏爽/降维打击"的开局，路径B可侧重"极限拉扯/悬疑解密"的开局，路径C可侧重"反套路解构/脑洞搞笑"的开局。',
      '【强一致性警告】\n推演必须严格锚定【核心冲突】中设定的"起步阶段"与"对抗势力"，严禁在开局场景上另起炉灶，严禁通过"系统阴谋论"等机械降神改变世界观底层逻辑！',
      '【输出要求】\n每条开局路径须包含以下字段：\n- title：极具张力的开局方案命名（包含风格标签）\n- summary：（600-800字）极其严密紧凑、细节丰满的开局设计，必须明确拆解为：\n  ① 开局钩子（前3章）：必须严格承接【核心冲突】中设定的"起步阶段"场景。如何以最具反差感的方式，在该起步场景中将主角卷入冲突（需具体到核心场景与异常信息差）。\n  ② 冲突引爆与代价：开局钩子如何迅速引爆核心矛盾，并迫使主角面临【核心冲突】中设定的不可逆代价（必须精准契合原设定的代价内涵）。\n  ③ 读者代入设计：如何在前3章建立读者对主角的强烈情感投射（身份认同/同情心/好奇心），以及开篇给读者画了什么"大饼"（追读期待）。\n  ④ 后台设定透出策略：庞大的世界观如何通过极其克制的细节在开篇自然流露，绝不长篇大论。\n- highlights：精准提炼3个直击读者多巴胺的核心爽点或深层情感共鸣点（每个点需展开说明1-2句）。\n- audience：精准定位目标受众画像，点明该路径满足了读者怎样的深层心理诉求（需深入剖析读者心理）。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      '注意：summary 字段必须是一个完整的字符串，不要将其拆分为数组或多个字段。请使用 \\n 来换行。',
      '【JSON结构示例】\n{"versions":[{"title":"...","summary":"①开局钩子：...\\n②冲突引爆与代价：...\\n③读者代入设计：...\\n④后台设定透出策略：...","highlights":["...","...","..."],"audience":"..."}]}'
    ].join('\n')
  },
  role_engine: {
    label: '角色驱动',
    step: 'incubator_role_engine',
    cardFormat: 'expand',
    slotTarget: 'role_engine',
    sourceStep: 'role_engine_gen',
    system: [
      '生成 3 套极其饱满完善的角色驱动方案。须与已给主题前提、核心冲突、世界规则完美契合，确保角色动机足以支撑整个故事的烈度，且在世界规则的压力系统下做出合理选择。',
      'summary（400-600字，必须包含丰富细节与深层心理剖析）：\n① 内驱力：主角最深层的执念与渴望（需说明其形成的历史渊源与不可动摇性）。\n② 致命缺陷：随时可能导致主角崩盘的性格弱点或认知盲区（需说明该缺陷如何引发致命危机）。\n③ 配角功能：详细设定催化剂、对照组、阻力角色的具体定位与互动方式（各用2-3句话展开说明其对主角的刺激作用）。\n④ 角色弧线：从开局到结局的完整心理与认知蜕变过程（需标明关键的觉醒节点）。\n⑤ 不可逆代价：若失败将失去的绝对不可挽回之物（需说明该事物对主角的终极意义）。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      '注意：summary 字段必须是一个完整的字符串，不要将其拆分为数组或多个字段。请使用 \\n 来换行。',
      cardExpandExample('①内驱力：...\\n②致命缺陷：...\\n③配角功能：...\\n④角色弧线：...\\n⑤不可逆代价：...')
    ].join('\n')
  },
  world_rules: {
    label: '世界规则',
    step: 'incubator_world_rules',
    cardFormat: 'expand',
    slotTarget: 'world_rules',
    sourceStep: 'world_rules_gen',
    system: [
      '生成 3 套逻辑严密、设定丰满的世界规则方案。须与已给主题前提、核心冲突、开局设计高度一致。规则必须具有强烈的压迫感，能逼迫主角做生死抉择，并至少一次严重反噬主角。',
      'summary（400-600字，必须包含具体运转机制与场景应用）：\n① 核心铁律：统治该世界的绝对法则（需详细说明其运作机制与不可违抗性）。\n② 规则代价：触碰或利用规则必须承受的残酷反噬（需具体到对主角身心或利益的实质损害）。\n③ 可利用漏洞：主角赖以破局的隐藏机制或规则悖论（需说明发现该漏洞的巧妙逻辑）。\n④ 服务冲突升级：该规则如何随着剧情推进，不断给主角施加呈指数级上升的压力（需列出3个阶段的压迫升级表现）。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      '注意：summary 字段必须是一个完整的字符串，不要将其拆分为数组或多个字段。请使用 \\n 来换行。',
      cardExpandExample('①核心铁律：...\\n②规则代价：...\\n③可利用漏洞：...\\n④服务冲突升级：...')
    ].join('\n')
  },
  rhythm_curve: {
    label: '节奏曲线（派生）',
    step: 'incubator_rhythm_curve',
    cardFormat: 'expand',
    sourceStep: 'rhythm_curve_gen',
    system: [
      '你是顶级的网文节奏设计大师。基于已确认的全部主线槽位（主题前提、核心冲突、世界规则、角色驱动、开局设计、终局设计），设计 3 套完整的读者情绪节奏曲线与章节节拍密度方案。',
      '【定位说明】',
      '节奏曲线是从开局到终局的叙事弧线中推导出来的派生分析，服务于主冲突的推进与角色成长弧，而非独立存在的创作决策。每个转折点须绑定具体的剧情事件与场景细节，绝对禁止空泛形容词堆砌。',
      '【输出要求】',
      '每套方案须包含以下字段：',
      '- title：极具张力的节奏方案命名（包含风格标签）',
      '- summary：（400-600字）必须包含具体的章节分布与事件锚点，明确拆解为：',
      '  ① 读者情绪旅程：从开篇到结局，读者应经历怎样的情绪起伏（如：开篇压迫感→中段爽点爆发→低谷绝望→终局释然/震撼），每个阶段需绑定具体的剧情触发事件与冲突升级节点。',
      '  ② 爽点频率与分布：全篇的爽点密度设计（如：每3-5章一次小爽点，每15-20章一次大高潮），说明爽点类型（智力碾压/战力爆发/情感突破/规则反噬等）及其与主冲突的咬合关系。',
      '  ③ 张力释放节奏（BPM映射）：以章节为粒度，描绘全篇的紧张-释放周期（如：前10章 BPM 120 高压建立世界观与冲突，11-25章 BPM 90 角色成长与规则探索，26-40章 BPM 150 多重冲突爆发，41-50章 BPM 60 终局收束与余韵）。',
      '  ④ 章节级钩子密度：每章结尾的悬念/钩子策略（信息差钩子/代价预告钩子/反转预警钩子），确保读者持续追读的动力不衰减。',
      '  ⑤ 情绪低谷与反弹点：至少设计 2-3 个读者情绪触底的节点，以及紧随其后的强力反弹事件，形成完整的情绪过山车效应。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      '注意：summary 字段必须是一个完整的字符串，不要将其拆分为数组或多个字段。请使用 \\n 来换行。',
      cardExpandExample('①读者情绪旅程：...\\n②爽点频率与分布：...\\n③张力释放节奏：...\\n④章节级钩子密度：...\\n⑤情绪低谷与反弹点：...')
    ].join('\n')
  },
  ending: {
    label: '终局设计',
    step: 'incubator_ending',
    cardFormat: 'expand',
    slotTarget: 'ending',
    sourceStep: 'ending_gen',
    system: [
      '你是顶级的网文终局架构师。基于已确认的主题前提、核心冲突、世界规则、角色驱动、开局设计，设计 3 套饱满且具有强烈感染力的终局方案。',
      '【核心理念】',
      '终局不是单一定格画面，而是包含冲突收束、角色弧闭合、世界状态定局、主题论证、读者离场情绪的完整结构。须让主角付出不可逆代价或做出不可撤回的终极选择。终局必须回答主题前提提出的命题。',
      '【输出要求】',
      '每套方案须包含以下字段：',
      '- title：极具感染力的终局方案命名',
      '- summary：（400-600字）必须充满结构张力与情感余韵，明确拆解为：',
      '  ① 冲突终极解决：主冲突如何迎来最终对决（谁胜谁负/或两败俱伤），不可逆代价的具体兑现方式，以及该代价给世界带来的永久性改变。',
      '  ② 角色弧线闭合：主角从开局的缺陷/执念，到终局的认知蜕变或彻底毁灭，需明确标注角色觉醒/臣服/超越的关键瞬间及其触发事件。',
      '  ③ 世界状态终局：故事世界的最终形态（旧秩序崩塌后的新秩序/规则被打破后的真空/一切回归原点但物是人非），说明这种终局状态与开篇世界状态的对照关系。',
      '  ④ 主题论证：终局如何回答主题前提提出的命题（是证实、证伪还是辩证超越），需说明最终立场及其说服力来源。',
      '  ⑤ 读者离场情绪与终局画面：极其详尽的电影级镜头描写（包含光影、色彩、声音、动作等细节，定格最震撼的瞬间）；精准设计读者看完最后一段的情绪反应（头皮发麻/泪流满面/细思极恐/怅然若失/热血沸腾）。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      '注意：summary 字段必须是一个完整的字符串，不要将其拆分为数组或多个字段。请使用 \\n 来换行。',
      cardExpandExample('①冲突终极解决：...\\n②角色弧线闭合：...\\n③世界状态终局：...\\n④主题论证：...\\n⑤读者离场情绪与终局画面：...')
    ].join('\n')
  },
  diagnose: {
    label: '诊断方向',
    step: 'incubator_diagnose',
    system: [
      '你是极其苛刻且专业的网文金牌主编。对故事方向做全方位、无死角的对抗式诊断，拒绝任何客套与模糊表达，必须一针见血指出致命缺陷。',
      '输出必须包含极其详尽的分析与可落地的指导：',
      '## 评分卡（吸引力/差异化/记忆点/冲突张力/可执行性，各0-100，每项必须附带2-3句深度点评理由）',
      '## 通过项（详细说明哪些设定具有爆款潜质及原因）',
      '## 阻断项（任一<60为阻断，必须深度剖析为何该设定会导致崩盘或读者流失）',
      '## 读者最可能弃书点（精准定位到具体情节/逻辑漏洞，并模拟读者的吐槽心理）',
      '## 修复动作（提供5-8条极其具体、可直接照做执行的保姆级修改方案，禁止说“加强冲突”，必须说“把X事件改为Y事件以引发Z冲突”）',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  reverse: {
    label: '倒推大纲',
    step: 'incubator_reverse',
    system: [
      '你是顶级的网文架构师。请从终局锚定进行极其严密的逆向工程，倒推生成一份饱满、无懈可击的大纲树。',
      '倒推路径：终局画面 → 高潮爆发 → 关键翻转 → 中段加压 → 开局钩子。每一步都必须写明极其具体的「不可逆代价」累积过程与「情绪势能」的积攒。',
      '输出高度详尽的倒推大纲树（Markdown格式）：',
      '每个节点必须包含：1. 核心事件描述（不少于50字）；2. 冲突双方的筹码与底牌；3. 角色心理状态；4. 对应的不可逆代价。',
      '末级节点必须能够完美、无缝地对应到前台钩子与主冲突轴。',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  anchors: {
    label: '提炼锚点',
    step: 'incubator_anchors',
    cardFormat: 'anchors',
    system: [
      '提炼 8-10 个绝对不可更改的核心锚点（涵盖关键场景/核心角色/重大情节/极致情感），每个锚点必须极其饱满，充满画面感与戏剧张力。',
      '',
      '输出严格 JSON 数组（不要 Markdown，不要解释）：',
      '[',
      '  {',
      '    "type": "scene|character|plot|emotion|structure|memory|contrast",',
      '    "scope": "work|volume|chapter",',
      '    "title": "锚点标题（≤20字，精炼概括）",',
      '    "content": "详细描述（100-200字），必须明确写出该锚点所蕴含的极致冲突张力、不可逆的代价暗示，以及它在整个故事结构中的承重作用"',
      '  }',
      ']',
      '',
      'scope 说明：',
      '- work（全书级）：贯穿始终的核心约束或主题，如"主角底线从不动摇"，≤3个',
      '- volume（分卷级）：某一阶段的核心推进目标，如"第二卷关键转折：从孤狼到组建团队"',
      '- chapter（章节级）：单章关键场景/情节/情感爆发点，如"京城大火：主角目睹灭门"',
      '',
      'type 说明：scene=场景 character=角色 plot=情节 emotion=情感 structure=结构 memory=记忆点 contrast=反差',
      INCUBATOR_ANTI_MEDIOCRITY,
      '只输出 JSON 数组，不要 JSON 外的任何文字。'
    ].join('\n')
  },
  benchmark: {
    label: '对标分析',
    step: 'incubator_benchmark',
    system: [
      '你是资深网文市场分析专家。请列出 3-5 部极其精准的对标爆款作品，进行深度解剖。',
      '输出必须包含详尽的分析：',
      '## 对标作品库（每部作品需详细分析其成功内核、与本案的相似点及本质差异点）',
      '## 可借鉴的爆款基因（提炼3-4条可直接复用的底层逻辑或爽点机制）',
      '## 必须避开的毒点与俗套清单（至少8条，必须详细说明为何这些套路在当前市场已失效或会引发读者反感）',
      '## 极致差异化策略（提供3条能让本案在同类竞品中脱颖而出的降维打击策略）',
      '## 精准市场定位（详细描绘核心受众画像、他们的核心诉求及本案的宣发侧重点）',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  tone: {
    label: '情感基调',
    step: 'incubator_tone',
    system: [
      '你是细腻的情感架构师。请输出极其详尽的情感-事件映射图谱，确保全书情绪节奏跌宕起伏、扣人心弦。',
      '输出要求：',
      '列出 6-10 个核心基调标签。',
      '每个标签必须对应极其具体的【情节触发点】（详细描述事件经过）与【读者情绪反应预期】。',
      '提供全局的【情绪节奏与BPM建议】（如：前三章BPM120高压，第五章BPM80舒缓等，并说明原因）。',
      '绝对禁止只列形容词而无事件锚点，必须做到情绪与情节的完美咬合。',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  frontstory: {
    label: '前台故事',
    step: 'incubator_frontstory',
    system: [
      '你是开篇定生死的第一关审核编辑。请对前台故事进行极其苛刻、细致入微的拆解，分析读者在黄金30秒内（前三章）可感知的冲突与追读动力。',
      '输出必须包含详尽的指导：',
      '## 前台钩子深度剖析（必须详细拆解异常信息差的构建方式、悬念的抛出时机）',
      '## 读者期待管理（详细说明开篇给读者画了什么大饼，以及如何保证这个期待的兑现）',
      '## 后台设定透出策略（说明庞大的世界观如何通过极其克制的细节在开篇自然流露，绝不长篇大论）',
      '## 开篇第一页保姆级建议（精确到第一段写什么、第一个出场人物的动作、第一句台词的张力）',
      '## 评分卡（钩子强度/信息差/代价可见性/代入感，各0-100，附带详细的扣分原因与提分建议）',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  microinnovation: {
    label: '微创新',
    step: 'incubator_microinnovation',
    system: [
      '你是深谙网文市场规律的创新操盘手。请基于“90%成熟套路 + 10%极致差异化”的黄金法则，进行极其饱满的微创新设计。',
      '输出必须包含详尽的拆解：',
      '## 必须保留的成熟套路（列出3-4个保障基本盘的爽点机制，并说明为何不能动）',
      '## 核心微创新点（详细描述这10%的创新到底新在哪里，必须附带「创新代价」与「失败风险」）',
      '## 金手指深度设定（详细拆解金手指的核心能力、极其苛刻的限制条件、以及致命的反噬机制）',
      '## 创新比例与节奏把控（说明在全书不同阶段，套路与创新的比例如何动态调整）',
      '## 风险提示与避坑指南（详细列出该创新点最容易写崩的3个雷区，并提供预防方案）',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  }
}

export const INCUBATOR_ANALYSIS_KEYS = Object.keys(INCUBATOR_ANALYSIS_PROMPTS)

/** AI 分析写入 core_settings 的 type 列表 */
export const INCUBATOR_ANALYSIS_SETTING_STEPS = [
  ...Object.values(INCUBATOR_ANALYSIS_PROMPTS).map(p => p.step),
  'incubator_diagnose_apply'
]

/** AI 分析同步到候选池的 source_step（不含 manual） */
export const INCUBATOR_ANALYSIS_CANDIDATE_SOURCE_STEPS = [
  'variants',
  'expand',
  'premise_gen',
  'role_engine_gen',
  'world_rules_gen',
  'rhythm_curve_gen',
  'ending_gen'
] as const satisfies readonly IncubatorCandidateSourceStep[]

/** 过程干预：微指令 system */
export const INCUBATOR_MICRO_INSTRUCT_SYSTEM = [
  '你是苛刻的小说结构编辑。根据微指令修改内容。',
  '修改时必须保持或增强冲突张力；不得把尖锐冲突改成温和妥协。',
  '只输出修改后的完整内容，不要解释。',
  '参考【目标范文】进行整体修改',
  INCUBATOR_ANTI_MEDIOCRITY
].join('\n')

export const INCUBATOR_REJECT_RETRY_SUFFIX =
  '请重新生成，且必须比上一版更极端、更尖锐、更出人意料；避免安全解与套路化表达。'

export const INCUBATOR_AB_VARIANTS_USER_SUFFIX = [
  '请生成三个版本，用 JSON 输出：',
  'A=最大冲突张力版（高风险高回报）；B=最大情感密度版（高记忆点高余韵）；C=融合建议（取A抓力+B余味）。',
  '各版 summary 约 400-600 字，必须极其饱满、细节丰富，须含不可逆代价。',
  '```json',
  '{"variants":[{"label":"A-张力版","summary":"..."},{"label":"B-情感版","summary":"..."},{"label":"C-融合版","summary":"..."}]}',
  '```'
].join('\n')

export const INCUBATOR_SELF_CHECK_SYSTEM = [
  '你是苛刻的责任编辑，读者付了钱不满意就会弃书。拒绝客套与「总体不错」。',
  '输出：## 评分卡（吸引力/差异化/记忆点/冲突张力/可执行性，各0-100，附一句理由）',
  '## 通过项 / ## 阻断项（任一<60为阻断）',
  '## 读者最可能弃书点（具体章节/情节位置）',
  '## 修改建议（最多5条，可执行）',
  INCUBATOR_ANTI_MEDIOCRITY
].join('\n')

/** 将诊断报告中的「修复动作」落到主线槽位（二次 LLM，输出 JSON） */
export const INCUBATOR_DIAGNOSE_APPLY_SYSTEM = [
  '你是主线编排编辑。根据「诊断方向」报告中的 ## 修复动作，将修复融入对应槽位的现有内容。',
  '规则：',
  '1) 只处理报告中明确、可写入槽位的修复项；不要臆造新剧情。',
  '2) text 是修复后该槽位的**完整内容**——把修复与原文合并，保留原有好的部分，修正有问题的部分，使全文连贯。',
  '3) 若该槽位原来为空，text 就是全新内容。',
  '4) 每条 patch 的 text 为可直接替换进槽位的 Markdown 段落（400-800字，必须极其饱满完善，细节丰富）。',
  '5) slotKey 只能是：premise、core_conflict、world_rules、role_engine、opening、ending。',
  INCUBATOR_ANTI_MEDIOCRITY,
  '只输出一个 JSON 对象，禁止其它文字：',
  '{"patches":[{"slotKey":"opening","text":"合并后的完整槽位内容..."}]}',
  '{"patches":[]} 仅在所有槽位均已完美、无法进一步改善时才可用。若报告指出任何问题或你发现槽位存在薄弱处，必须给出至少一条修复 patch。'
].join('\n')

export function buildDiagnoseApplyUserPrompt(
  seed: string,
  slots: Partial<Record<IncubatorSlotKey, string>>,
  diagnoseReport: string,
  characters?: string[]
): string {
  const block = buildSlotAnchorBlock(slots, [...INCUBATOR_SLOT_KEYS])
  const parts = [
    '【创作种子】',
    seed.trim(),
    '',
    '【当前主线槽位】',
    block || '（各槽均为空）',
    '',
    '【诊断方向报告（请只执行其中 ## 修复动作）】',
    diagnoseReport.trim()
  ]
  if (characters && characters.length > 0) {
    parts.push('', '【可选择的角色名称库】', `角色：${characters.join('、')}`, '（注意：进行修复入槽动作时，涉及人物名称请务必优先且只能从上述已知角色名称中进行挑选和关联，禁止自行生成或编造新角色名字）')
  } else {
    parts.push('', '【角色命名严格约束】', '涉及人物名称时，禁止自行臆造具体人名。主角请统一使用"男主"、"女主"指代，若需提及配角与反派请统一使用"张某"、"李某"、"王某"等泛化代称。')
  }
  return parts.join('\n')
}

/** 门禁判定（AI）system：输出结构化门禁报告 JSON，含可局部替换的 replacements */
export const INCUBATOR_GATE_CHECK_SYSTEM = [
  '你是资深网文结构编辑与极其苛刻的逻辑推敲专家，负责对「主线槽位」进行严格的门禁判定。',
  '【核心判定理念】',
  '你必须从整体出发，把各槽位视作一个完整的、连续的短故事大纲。故事是精密耦合的齿轮系统，不能孤立、割裂地审核单个槽位。你必须先对全局逻辑和结构进行推演，再将发现的具体问题定位并推送到对应的槽位中。',
  '判定目标：判断该主线是否可进入冻结流程。你必须从【强逻辑】角度对大纲进行极限抗压测试，揪出所有隐藏的设定冲突、机制漏洞与动机错位。',
  '输出要求：',
  '1) 必须输出 JSON 对象，禁止 Markdown、解释、代码块外文字。',
  '2) passed=true 仅在“核心阻断项均解除”时给出；若存在明显结构问题必须为 false。',
  '3) serializabilityScore / conflictClosureScore 为 0-100 整数。',
  '4) coherence 仅列跨槽一致性问题，slotKey 只能是 premise/core_conflict/world_rules/role_engine/opening/ending，severity 只能是 blocking 或 warning。',
  '5) blocking 代表冻结阻断；warning 为建议优化，不阻断冻结。',
  '6) 每个 coherence 项必须包含 replacements 数组：每条 {original, replacement} 表示将槽位中的 original 文本替换为 replacement 文本。',
  '   - **极其重要**：original 必须从上方【主线槽位】原文中**逐字逐标点复制粘贴**，禁止凭记忆改写、禁止省略任何标点符号或空格、禁止调整措辞。哪怕原文有错别字也要原样保留。',
  '   - replacement 是修复后的替换文本，可以比 original 更长或更短。',
  '   - 若需要在槽位末尾追加内容，original 写为槽位最后一句（含句末标点），replacement 写为该句+追加内容。',
  '   - 一个 coherence 项可包含多条 replacements（针对同一槽位的多处修改）。',
  '判定重点（第一性原则）：',
  '- 强逻辑闭环与机制自洽（阻断级）：深挖设定的底层逻辑是否存在相悖（如能量来源与运转方式矛盾）、破局机制是否发生过不合理的跨越。',
  '- 角色动机与行为一致性（阻断级）：推敲角色的每一次关键行为（特别是“送人头”、“阻挠”行为）是否完全符合其核心诉求。严禁任何“为了推进剧情而强行降智或动机割裂”的工具人行为。',
  '- 主冲突是否清晰且可持续推进（谁与谁争什么，代价是否不可逆）。',
  '- 世界规则是否构成压力系统，并能持续逼迫角色选择。',
  '- 主线槽位之间是否因果闭环（开局→冲突升级→情感转折→终局收束）。',
  '严格输出以下 JSON 形状（注意，`global_analysis` 必须排在 JSON 的最前面，作为你对故事大纲整体的预先推演和审视分析）：',
  '{"global_analysis":"（此处为把主线槽位作为一个完整故事大纲的整体分析与发现的问题，300-500字。先分析整体设定一致性、因果链条闭环度及动机合理性，完成后再把发现的具体问题映射推送到下方 slots 对应项中）","passed":false,"serializabilityScore":0,"conflictClosureScore":0,"issues":["整体发现的大纲核心逻辑问题1"],"suggestions":["对应的整体修改建议1"],"coherence":[{"slotKey":"role_engine","severity":"blocking","issue":"问题描述","suggestion":"修复建议","replacements":[{"original":"槽位中需要替换的原文片段","replacement":"替换后的新文本"}]}]}'
].join('\n')

/** 组装 AI 门禁判定 user prompt */
export function buildGateCheckUserPrompt(
  slots: Partial<Record<IncubatorSlotKey, string>>,
  seed?: string,
  characters?: string[],
  userInstruction?: string
): string {
  const parts = [
    '【任务】请依据下列主线槽位内容进行门禁判定，并为每个阻断/警告项提供可直接应用的 replacements（局部替换）。',
    ''
  ]
  if (seed?.trim()) {
    parts.push('【创作种子】', seed.trim(), '')
  }
  parts.push('【主线槽位】', buildSlotAnchorBlock(slots, [...INCUBATOR_SLOT_KEYS]) || '（各槽均为空）')
  if (characters && characters.length > 0) {
    parts.push('', '【角色名称库】', `角色：${characters.join('、')}`, '（涉及人物名称请务必从上述已知角色名称中挑选，禁止编造新角色名字）')
  } else {
    parts.push('', '【角色命名严格约束】', '涉及人物名称时，禁止自行臆造具体人名。主角请统一使用"男主"、"女主"指代，若需提及配角与反派请统一使用"张某"、"李某"、"王某"等泛化代称。')
  }
  if (userInstruction?.trim()) {
    parts.push('', '【用户的指导性意见/人工审查指令】', userInstruction.trim(), '（请务必优先且严格遵循上述人工意见与审查指令，对指定内容/逻辑开展针对性校验和修正判定）')
  }
  return parts.join('\n')
}

/** 将门禁报告格式化为 LLM 可读的修复输入 */
export function formatGateReportForFix(report: IncubatorGateReport): string {
  const lines: string[] = [
    `门禁结果：${report.passed ? '通过' : '未通过'}`,
    `已填槽位：${report.filledSlotCount}/${INCUBATOR_SLOT_KEYS.length}`,
    `可连载性评分：${report.serializabilityScore}`,
    `冲突闭环评分：${report.conflictClosureScore}`
  ]

  const blocking = report.coherence?.filter(c => c.severity === 'blocking') ?? []
  const warnings = report.coherence?.filter(c => c.severity === 'warning') ?? []

  if (blocking.length) {
    lines.push('', '## 阻断项（必须修复）')
    for (const item of blocking) {
      lines.push(`- [${INCUBATOR_SLOT_LABELS[item.slotKey]}] ${item.issue}`)
      lines.push(`  修复建议：${item.suggestion}`)
    }
  }

  if (report.issues.length) {
    lines.push('', '## 门禁问题')
    report.issues.forEach((issue, i) => {
      lines.push(`- ${issue}`)
      const suggestion = report.suggestions[i]
      if (suggestion) lines.push(`  修复建议：${suggestion}`)
    })
  }

  if (warnings.length) {
    lines.push('', '## 警告项（有余力时改善）')
    for (const item of warnings) {
      lines.push(`- [${INCUBATOR_SLOT_LABELS[item.slotKey]}] ${item.issue}`)
      lines.push(`  修复建议：${item.suggestion}`)
    }
  }

  return lines.join('\n')
}

/** 将门禁阻断项落到主线槽位（二次 LLM，输出 JSON） */
export const INCUBATOR_GATE_FIX_SYSTEM = [
  '你是主线编排编辑。根据「门禁校验报告」中的阻断项，修复对应槽位内容使门禁可通过。',
  '【底层逻辑要求】故事是一个牵一发而动全身的精密齿轮。修复一个逻辑漏洞（例如改了主角的动机），必然会引发蝴蝶效应，导致后面的节奏、冲突或终局失去支撑。因此，你不能只做“局部打补丁”。',
  '规则：',
  '1) 全局连动：必须修复所有阻断项。若修复动作改变了某个核心设定，你必须同步检查并修改其他槽位（哪怕它原本是 passed 的），确保整个主线槽位逻辑依然闭环。',
  '2) 强制沙盘推演：在输出修复内容前，必须在 JSON 的 `logic_rebuild` 字段中进行简短的全局逻辑重建推演，写明“因为改了X，所以Y和Z也必须跟着改”。',
  '3) text 是修复后该槽位的**完整内容**——把修复与原文合并，保留原有好的部分，修正有问题的部分，使全文连贯。',
  '4) 若槽位为空且阻断原因为未填满，须基于创作种子写出该槽位初稿（400-800字，必须极其饱满完善，细节丰富）。',
  '5) 修复须落实报告中的「修复建议」，使跨槽关键词、规则代价、角色弧线、首尾呼应等一致。',
  '6) slotKey 只能是：premise、core_conflict、world_rules、role_engine、opening、ending。',
  INCUBATOR_ANTI_MEDIOCRITY,
  '只输出一个 JSON 对象，禁止其它文字：',
  '{"logic_rebuild":"（全局逻辑重构推演，200字以内，写明蝴蝶效应和跨槽联动）", "patches":[{"slotKey":"opening","text":"合并后的完整槽位内容..."}]}',
  '{"logic_rebuild":"无阻断", "patches":[]} 仅在所有槽位均已完美、无法进一步改善时才可用。若报告指出任何问题或你发现槽位存在薄弱处，必须给出至少一条修复 patch。'
].join('\n')

export function buildGateFixUserPrompt(
  seed: string,
  slots: Partial<Record<IncubatorSlotKey, string>>,
  gateReport: IncubatorGateReport,
  characters?: string[]
): string {
  const block = buildSlotAnchorBlock(slots, [...INCUBATOR_SLOT_KEYS])
  const parts = [
    '【创作种子】',
    seed.trim(),
    '',
    '【当前主线槽位】',
    block || '（各槽均为空）',
    '',
    '【门禁校验报告】',
    formatGateReportForFix(gateReport)
  ]
  if (characters && characters.length > 0) {
    parts.push('', '【可选择的角色名称库】', `角色：${characters.join('、')}`, '（注意：进行门禁自动修复时，涉及人物名称请务必优先且只能从上述已知角色名称中进行挑选和关联，禁止自行生成或编造新角色名字）')
  } else {
    parts.push('', '【角色命名严格约束】', '涉及人物名称时，禁止自行臆造具体人名。主角请统一使用"男主"、"女主"指代，若需提及配角与反派请统一使用"张某"、"李某"、"王某"等泛化代称。')
  }
  return parts.join('\n')
}

/** 按用户微调指令修订主线槽位（输出 JSON patches） */
export const INCUBATOR_TWEAK_SYSTEM = [
  '你是主线编排编辑。根据用户的「微调指令」，在现有主线槽位内容上做精准修订。',
  '规则：',
  '1) 严格落实用户指令（如改名、改称谓、统一术语、删减/补充某设定），勿擅自改动无关部分。',
  '2) text 是修订后该槽位的**完整内容**——在原文基础上合并修改，保留未涉及的部分与整体结构，且必须保持内容的极其饱满与细节丰富。',
  '3) 若指令涉及跨槽一致性（如主角改名），须同步修改所有出现该名称的槽位。',
  '4) 只做指令要求的调整，勿扩写无中生有的剧情、勿重写已通过的结构；专有名词替换时保持原有篇幅。',
  '5) slotKey 只能是：premise、core_conflict、world_rules、role_engine、opening、ending（禁止使用 main_conflict 等别名）。',
  '6) patches 仅包含实际需修改的槽位；无变更的槽位不要输出。',
  INCUBATOR_ANTI_MEDIOCRITY,
  '只输出一个 JSON 对象，禁止其它文字：',
  '{"patches":[{"slotKey":"opening","text":"修订后的完整槽位内容..."}]}',
  '指令无法落实或无需修改时输出 {"patches":[]}'
].join('\n')

export function buildTweakUserPrompt(
  seed: string,
  slots: Partial<Record<IncubatorSlotKey, string>>,
  tweakInstructions: string,
  characters?: string[]
): string {
  const block = buildSlotAnchorBlock(slots, [...INCUBATOR_SLOT_KEYS])
  const parts = [
    '【创作种子】',
    seed.trim(),
    '',
    '【当前主线槽位】',
    block || '（各槽均为空）',
    '',
    '【用户微调指令】',
    tweakInstructions.trim()
  ]
  if (characters && characters.length > 0) {
    parts.push('', '【可选择的角色名称库】', `角色：${characters.join('、')}`, '（注意：进行主线微调时，涉及人物名称请务必优先且只能从上述已知角色名称中进行挑选和关联，禁止自行生成或编造新角色名字）')
  } else {
    parts.push('', '【角色命名严格约束】', '涉及人物名称时，禁止自行臆造具体人名。主角请统一使用"男主"、"女主"指代，若需提及配角与反派请统一使用"张某"、"李某"、"王某"等泛化代称。')
  }
  return parts.join('\n')
}

export const INCUBATOR_SYNTHESIZE_SYSTEM = [
  '你是主线统合编辑。将下列各槽位内容融合为一份连贯的主线摘要。',
  '要求：统一称谓与因果链；消除重复；保留所有不可逆代价与反常识钩子；不得弱化冲突。',
  '输出 Markdown，且仅包含以下两节：',
  '## 统合主线摘要（800-1500字，因果清晰、可读性强、极其饱满完善，包含所有核心细节）',
  '## 质量评分卡（吸引力/差异化/记忆点/冲突张力/连贯性，各0-100）'
].join('\n')
