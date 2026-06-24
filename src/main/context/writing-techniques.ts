import { outlineConstraintsForWordTarget } from '../../shared/outline-constraints'

/** 活跃锚点注入上限（超出部分不注入正文，避免 checklist 式断片） */
export const MAX_ACTIVE_ANCHORS = 12

export const BODY_CONTINUITY_RULE = [
  '【正文连贯性约束 - 硬约束】',
  '1. 「衔接」≠「重复」：你的第一句话必须紧接上一章结尾之后往下写，写上一章结尾之后发生的新事件。' +
  '绝对禁止以任何形式复述/改写/概括上一章结尾已有的场景、对话、动作或心理活动——即使换了措辞也算重复。' +
  '如果上一章以"他转身离去"结尾，你不能写"他转过身"或"他的背影消失"，而应直接写他离去之后的新情节。' +
  '章节大纲是本章的内容指引，不是叙事起点——先从上一章结尾之后的时间点切入，再自然过渡到大纲内容',
  '2. 人物言行须与角色快照、人设卡片一致',
  '3. 用场景与动作展示性格，避免直述「性格XX」「十分美丽」',
  '4. 本章只完成大纲任务，不提前写后续章节内容',
  '5. 环境描写只在场景首次出现时点到为止（1-2句），之后靠角色互动推进；同一章中同一自然意象（雨/风/光线等）不要反复出现超过 3 次'
].join('\n')

export const STYLE_CORE_DIRECTIVE =
  '若提供【目标范文】或风格参数，请提炼其句长节奏、对话密度和信息分布并尽量贴合；严禁照抄原句，但可复用其叙事节奏与表达习惯。'

export const STYLE_ANCHOR_TEMPLATE = [
  '【文风执行指令 - 正文生成必须遵守】',
  '你必须严格按照 system 中【目标范文】的文风文笔生成正文，具体要求：',
  '1. 句式节奏：模仿范文的句长分布和段落结构，不得自行发挥为散文体或诗化体',
  '2. 对话密度：对话占比须落在范文对应区间内，对话须简洁有锋芒',
  '3. 描写手法：按范文风格选择白描/分镜/留白等手法，禁止堆砌华丽修辞',
  '4. 环境克制：场景转换时最多 1-2 句点到即止，禁止同一意象（雨/风/灯光等）反复出现；环境描写占比不超过全章 10%',
  '5. 信息节奏：每段须推进情节或揭示信息，禁止纯过渡废段',
  '6. 量化自检：生成后须符合【量化自检】中所有指标范围',
  '',
  '【优先级说明】',
  '- 剧情覆盖与角色一致性 > 文风贴合 > 字数精确',
  '- 允许局部口语化与不对称句式，避免模板化',
  '- 若风格要求与大纲/角色一致性冲突，以剧情与角色一致性优先',
  '- 若"去AI味规则"与【目标范文】冲突，以【目标范文】为准；去AI规则仅用于消除模板句，不得改变范文笔法'
].join('\n')

export const INCUBATOR_FRONTSTORY_PROMPT = [
  '分析以下故事方向的「前台故事」——读者打开正文 30 秒内能感知到的核心冲突与追读动力。',
  '输出 Markdown：',
  '## 前台钩子（一句话）',
  '## 读者期待（3条）',
  '## 后台设定（暂不露出的部分）',
  '## 开篇第一页建议（具体场景+悬念，忌背景介绍开场）',
  '## 评分（1-10）与改进建议'
].join('\n')

export const INCUBATOR_MICROINNOVATION_PROMPT = [
  '对以下故事方向做「微创新」分析（约 90% 成熟套路 + 10% 差异化）。',
  '输出 Markdown：',
  '## 可保留的套路元素',
  '## 建议创新点（人设/金手指/世界观，各 1-2 条）',
  '## 金手指设计（能力 + 限制条件，忌无敌）',
  '## 创新比例评估（套路% / 创新%）',
  '## 风险提示（步子是否迈太大）'
].join('\n')

/** 孵化器 · 变体探索：仅 JSON */
export const INCUBATOR_VARIANTS_JSON_PROMPT = [
  '基于故事方向，生成 6 个不同维度的变体（如性别互换、时代背景、视角切换、冲突类型改变等）。',
  '只输出一个 JSON 对象，禁止 Markdown 正文、标题、解释或代码块外的任何文字。',
  'variants 数组每项为一变体；不要把「变体维度」「变体探索」等标签当作 title。',
  '每变体 summary 约 80-120 字；dimension 写变体维度名称。',
  '示例：{"variants":[{"title":"古代志怪版","dimension":"时代背景改变","summary":"…"}]}'
].join('\n')

/** 孵化器 · 方向扩写：仅 JSON */
export const INCUBATOR_EXPAND_JSON_PROMPT = [
  '基于故事方向，生成 3 个不同方向的扩写版本。',
  '只输出一个 JSON 对象，禁止 Markdown 正文、标题、解释或代码块外的任何文字。',
  'versions 数组每项为一版本；不要把「核心亮点」「受众定位」等标签当作 title。',
  '每版 summary 约 150-250 字；highlights 写核心亮点；audience 写受众定位。',
  '示例：{"versions":[{"title":"版本名","summary":"扩写摘要","highlights":"亮点","audience":"受众"}]}'
].join('\n')

export const CHARACTER_CARDS_AI_PROMPT = [
  '基于故事方向，为 3-5 个主要角色生成结构化人设卡片。',
  '若上下文含「用户补充要求」，须严格遵守（含角色姓名、关系、禁忌等），并在 name 字段中使用指定姓名。',
  'cards 中至少包含 1 个 protagonist；若存在主要对手，需包含 antagonist。',
  '每张卡片必须包含 memoryTag、coreConflict、relationBinding，且 coreConflict 要能映射到主线冲突。',
  '只输出 JSON，禁止输出 Markdown 正文、标题或解释文字。',
  '每张卡片各字段值须简洁：memoryTag 不超过 80 字，coreConflict 不超过 60 字，',
  'speechStyle 不超过 80 字，relationBinding 不超过 60 字，reactions 每项不超过 30 字。',
  '格式：',
  '```json',
  '{',
  '  "cards": [',
  '    {',
  '      "name": "角色名",',
  '      "role": "protagonist|supporting|antagonist",',
  '      "memoryTag": "独特记忆标签（含外貌/身份/关键特征，≤80字）",',
  '      "coreConflict": "核心矛盾（一句话，≤60字）",',
  '      "reactions": { "instinct": "本能反应（≤30字）", "rational": "理性反应（≤30字）", "hidden": "隐藏反应（≤30字）" },',
  '      "speechStyle": "语言风格（含口头禅/句式特征，≤80字）",',
  '      "growthTriggers": ["触发事件1", "触发事件2"],',
  '      "relationBinding": "关系绑定描述（≤60字）"',
  '    }',
  '  ]',
  '}',
  '```'
].join('\n')

export const CHAPTER_ABC_OUTLINE_PROMPT = [
  '爽点链字段：',
  '- beat_role: A(爽点释放)/B(进行中)/C(铺垫下一爽点)/transition(过渡)',
  '- foreshadow_target: 本章铺垫的下一节点',
  '- next_hook: 章末钩子（写入 JSON 字段，不要单独成章）'
].join('\n')

/** 批量生成分卷章节：仅 JSON */
export const VOLUME_CHAPTERS_BATCH_JSON_PROMPT = [
  '根据分卷信息与作品上下文，生成本卷章节情节大纲。',
  '【输出格式 - 必须严格遵守】',
  '只输出一个 JSON 对象；禁止 Markdown 章节标题、前置说明、分析过程，以及 ``` 代码块围栏。',
  'chapters 数组每一项代表一章；不要把「卷X章节大纲」「分章情节」「章节结尾钩子」等文档标题当作 title。',
  '每章字段：title、outline（或 plot_points 数组）、beat_role、foreshadow_target、next_hook、characters（本章出场角色名数组）。',
  CHAPTER_ABC_OUTLINE_PROMPT,
  '- characters: 从人设卡片或核心设定中选取本章实际出场角色',
  '【长度】outline / plot_points 合计约 300-600 字；禁止写正文级对话与场景描写。',
  '格式：{"chapters":[{"title":"第1章 雨夜书店","outline":"情节摘要","beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}]}'
].join('\n')

/** 单章 AI 大纲：仅 JSON */
export const CHAPTER_OUTLINE_JSON_PROMPT = [
  '为指定章节生成情节大纲（写作指令，不是正文）。',
  '只输出一个 JSON 对象，禁止 Markdown 与代码块外说明。',
  'plot_points 为 3-5 条情节节点；next_hook 写在 JSON 字段，不要单独作为标题或章节。',
  CHAPTER_ABC_OUTLINE_PROMPT,
  '【长度】plot_points 合计约 300-600 字。',
  '格式：{"plot_points":["节点1","节点2"],"beat_role":"B","foreshadow_target":"...","next_hook":"..."}'
].join('\n')

/** 章节情节大纲长度与体裁约束（规划层，非正文） */
export function chapterOutlineLengthRules(wordsPerChapter = 4000): string {
  const c = outlineConstraintsForWordTarget(wordsPerChapter)
  return [
    '【章节情节大纲体裁 - 必须遵守】',
    '1. 大纲是写作指令，不是正文：只写事件链、冲突、转折，禁止写完整对话/场景描写/心理独白',
    `2. 每章 plot_points 合计约 ${c.charsMin}-${c.charsMax} 字；超过 ${c.charsWarn} 字视为不合格`,
    `3. ${c.pointsMin}-${c.pointsMax} 个 plot_points，每点 1-3 句梗概`,
    '4. beat_role / foreshadow_target / next_hook 仅作为 JSON 字段，不得拆成独立「章节」'
  ].join('\n')
}

export const CHAPTER_OUTLINE_LENGTH_RULES = chapterOutlineLengthRules()

export function chapterOutlineTargetChars(wordsPerChapter = 4000) {
  const c = outlineConstraintsForWordTarget(wordsPerChapter)
  return { min: c.charsMin, max: c.charsMax, warn: c.charsWarn }
}

export const CHAPTER_OUTLINE_TARGET_CHARS = { min: 300, max: 600, warn: 800 } as const

/** 分卷大纲：每卷 description 字数上限（生成与注入摘要用） */
export const VOLUME_OUTLINE_TARGET_CHARS = { min: 80, max: 300, compactInject: 80 } as const

export const VOLUME_OUTLINE_LENGTH_RULES = [
  '【分卷大纲体裁 - 必须遵守】',
  '1. 每卷 description 仅写核心主题、主冲突、卷末钩子，禁止写具体章节情节或场景描写',
  '2. 每卷 description 控制在 80-300 字；超过 400 字视为不合格',
  '3. JSON 中 description 字段须可直接作为写作约束，不要写成市场分析或创作笔记',
  '4. theme / core_conflict / end_hook 仅作为同卷 JSON 字段，不得拆成独立「分卷」'
].join('\n')

/** 批量生成分卷：仅 JSON */
export const VOLUMES_OUTLINE_JSON_PROMPT = [
  '根据作品创作上下文，生成 3-5 卷分卷大纲。',
  '只输出一个 JSON 对象，禁止 Markdown 正文、标题、解释或代码块外的任何文字。',
  'volumes 数组每项为一卷；不要把「分卷大纲」「卷末钩子」「核心冲突」等标签当作 name。',
  '每卷用 description（80-300 字，含主题/主冲突/卷末钩子），或 theme + core_conflict + end_hook 三字段。',
  VOLUME_OUTLINE_LENGTH_RULES,
  '示例：{"volumes":[{"name":"卷一：《雨夜书店的猫》","description":"主题…；主冲突…；卷末钩子…"}]}'
].join('\n')

export const WRITER_BLOCK_TYPES = {
  plot_stuck: {
    label: '情节卡顿',
    hint: '复盘大纲/细纲 → 加快进度精简情节 → 换地图或拉配角支线，忌水文凑字'
  },
  no_framework: {
    label: '无框架卡文',
    hint: '回头整理细纲，找未填的坑；下一本务必先完成大纲与人设卡片'
  },
  flat_pacing: {
    label: '剧情平淡',
    hint: '检查 ABC 爽点链是否断裂；考虑加快进度或引入新冲突'
  },
  character_flat: {
    label: '人物扁平',
    hint: '补充人设卡片的核心矛盾与记忆标签；用事件展示而非形容词堆砌'
  },
  personal: {
    label: '状态/灵感',
    hint: '休息 1-2 天；翻素材库与灵感板；不要硬写流水账'
  }
} as const
