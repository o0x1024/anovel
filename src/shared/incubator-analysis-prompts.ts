import { INCUBATOR_SLOT_KEYS, INCUBATOR_SLOT_LABELS, type IncubatorSlotKey } from './incubator-slots'

/** 反平庸硬约束（结构化分析类 prompt 共用） */
export const INCUBATOR_ANTI_MEDIOCRITY = [
  '额外硬约束（必须遵守）：',
  '1) 禁止以「误会解除、天降帮助、主角开挂、靠沟通化解一切」作为核心解法。',
  '2) 每个方案必须写明「不可逆代价」：失败后将永久失去的关系、身份、能力或机会之一。',
  '3) 每个方案必须包含 1 个「反常识但自洽」的设计点，并说明其合理性。',
  '4) 冲突至少三段升级：轻压 → 重压 → 破局或崩盘，不得平铺直叙。',
  '5) 若内容可替换到任意题材、缺乏专属记忆点，视为不合格，须重写。'
].join('\n')

/** 建议用户按此顺序填充槽位 / 运行分析 */
export const INCUBATOR_SLOT_FILL_ORDER: IncubatorSlotKey[] = [
  'hook',
  'core_conflict',
  'role_engine',
  'world_rules',
  'emotion_curve',
  'ending_image'
]

/** 各分析在生成时，应注入的已填槽位（链式约束） */
export const ANALYSIS_SLOT_ANCHORS: Partial<Record<string, IncubatorSlotKey[]>> = {
  expand: ['hook', 'core_conflict'],
  variants: ['hook'],
  role_engine: ['hook', 'core_conflict'],
  world_rules: ['hook', 'core_conflict', 'role_engine'],
  emotion_curve: ['hook', 'core_conflict', 'role_engine'],
  ending_image: ['hook', 'core_conflict', 'emotion_curve'],
  diagnose: [...INCUBATOR_SLOT_KEYS],
  reverse: [...INCUBATOR_SLOT_KEYS],
  anchors: ['hook', 'core_conflict'],
  benchmark: ['hook', 'core_conflict'],
  tone: ['hook', 'emotion_curve'],
  frontstory: ['hook', 'core_conflict'],
  microinnovation: ['hook', 'core_conflict', 'world_rules']
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
  analysisKey: string
): string {
  const anchors = ANALYSIS_SLOT_ANCHORS[analysisKey]
  const block = buildSlotAnchorBlock(slots, anchors)
  const sections = [`【创作种子】\n${seed.trim()}`]
  if (block) sections.push(block)
  return sections.join('\n\n')
}

const JSON_ONLY = '只输出一个 JSON 对象，禁止 Markdown、标题、解释或代码块外的任何文字。'

function cardExpandExample(fields: string): string {
  return `示例：{"versions":[{"title":"方案名","summary":"${fields}"}]}`
}

export const INCUBATOR_ANALYSIS_PROMPTS: Record<
  string,
  { label: string; step: string; system: string; cardFormat?: 'variants' | 'expand'; slotTarget?: IncubatorSlotKey; sourceStep?: string }
> = {
  variants: {
    label: '变体探索',
    step: 'incubator_variants',
    cardFormat: 'variants',
    slotTarget: 'core_conflict',
    sourceStep: 'variants',
    system: [
      '你是故事结构策划师。基于创作种子，沿 6 个互不重复的维度生成变体。',
      '维度示例：性别互换、时代背景、视角切换、冲突类型、类型融合、叙事结构实验、道德灰度、受众转向。',
      '每变体须含：title、dimension、summary（120-180字）——①核心冲突（谁vs谁争什么）②不可逆代价 ③三段升级路径 ④反常识钩子 ⑤读者追读理由。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      '示例：{"variants":[{"title":"古代志怪版","dimension":"时代背景改变","summary":"核心冲突：…不可逆代价：…升级：…反常识：…追读：…"}]}'
    ].join('\n')
  },
  expand: {
    label: '方向扩写',
    step: 'incubator_expand',
    cardFormat: 'expand',
    slotTarget: 'hook',
    sourceStep: 'expand',
    system: [
      '你是故事结构策划师。生成 3 条互不重复的故事路径（非微调）。',
      '每版须含：title；summary（200-300字）——①开局钩子（前3章）②主线冲突与不可逆代价 ③中段至少1次意外翻转 ④高潮与结局；highlights；audience。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      cardExpandExample('开局钩子：…冲突代价：…翻转：…结局：…')
    ].join('\n')
  },
  role_engine: {
    label: '角色驱动轴',
    step: 'incubator_role_engine',
    cardFormat: 'expand',
    slotTarget: 'role_engine',
    sourceStep: 'role_engine_gen',
    system: [
      '生成 3 套角色驱动方案。须与已给主冲突轴一致。',
      'summary（150-250字）：①内驱力 ②致命缺陷 ③配角功能（催化剂/对照/阻力各一句）④角色弧线 ⑤若失败将失去的不可逆之物。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      cardExpandExample('内驱力：…缺陷：…配角：…弧线：…代价：…')
    ].join('\n')
  },
  world_rules: {
    label: '世界规则轴',
    step: 'incubator_world_rules',
    cardFormat: 'expand',
    slotTarget: 'world_rules',
    sourceStep: 'world_rules_gen',
    system: [
      '生成 3 套世界规则方案。须与已给前台钩子、主冲突轴、角色驱动轴一致。规则必须逼迫主角做选择，并至少一次反噬主角。',
      'summary：①核心铁律 ②规则代价 ③可利用漏洞 ④如何服务主冲突升级。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      cardExpandExample('铁律：…代价：…漏洞：…服务冲突：…')
    ].join('\n')
  },
  emotion_curve: {
    label: '情感曲线轴',
    step: 'incubator_emotion_curve',
    cardFormat: 'expand',
    slotTarget: 'emotion_curve',
    sourceStep: 'emotion_curve_gen',
    system: [
      '生成 3 套情感曲线。每个转折点必须绑定具体情节事件，禁止空泛形容词堆砌。',
      '称谓硬约束：全文禁止出现具体人名、外号、姓氏或「某某」式命名；角色一律用代称——核心双人用「男主」「女主」，其余用「男二」「女二」「反派」「长辈」等职能代称。若角色驱动轴里有人名，改写为代称后再写曲线，不得照搬人名。',
      'summary：①情感起点 ②2-3个转折事件 ③情感高潮触发 ④余韵（释然/怅然/战栗）。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      cardExpandExample('起点：男主…女主…；转折：男主…；高潮：女主…；余韵：…')
    ].join('\n')
  },
  ending_image: {
    label: '终局意象',
    step: 'incubator_ending_image',
    cardFormat: 'expand',
    slotTarget: 'ending_image',
    sourceStep: 'ending_image_gen',
    system: [
      '生成 3 个终局意象。结局须让主角付出不可逆代价或做出不可撤回的选择。',
      'summary：①终局画面 ②主题升华 ③与开局呼应 ④读者离场感受。',
      INCUBATOR_ANTI_MEDIOCRITY,
      JSON_ONLY,
      cardExpandExample('画面：…主题：…呼应：…离场：…')
    ].join('\n')
  },
  diagnose: {
    label: '诊断方向',
    step: 'incubator_diagnose',
    system: [
      '你是苛刻的责任编辑。对故事方向做对抗式诊断，拒绝客套。',
      '输出：## 评分卡（吸引力/差异化/记忆点/冲突张力/可执行性，各0-100）',
      '## 通过项 / ## 阻断项（任一<60为阻断） / ## 读者最可能弃书点 / ## 修复动作（最多5条，可执行）',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  reverse: {
    label: '倒推大纲',
    step: 'incubator_reverse',
    system: [
      '从终局锚定倒推：终局画面→高潮→关键翻转→中段加压→开局钩子。每步写明「不可逆代价」累积。',
      '输出倒推大纲树（Markdown），末级节点须可对应到前台钩子与主冲突轴。',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  anchors: {
    label: '提炼锚点',
    step: 'incubator_anchors',
    system: [
      '提炼5-8个不可更改的核心锚点（场景/角色/情节/情感），每个须含冲突张力或代价暗示。',
      '格式：- [类型] 标题：描述',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  benchmark: {
    label: '对标分析',
    step: 'incubator_benchmark',
    system: [
      '列出3-5部对标作品（相似点/差异点）。',
      '## 可借鉴 / ## 应避开的俗套清单（至少5条） / ## 差异化策略 / ## 市场定位',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  tone: {
    label: '情感基调',
    step: 'incubator_tone',
    system: [
      '输出情感-事件映射：5-8个基调标签 + 每个标签对应的具体情节触发点 + 节奏建议。',
      '禁止只列形容词而无事件锚点。',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  frontstory: {
    label: '前台故事',
    step: 'incubator_frontstory',
    system: [
      '分析30秒内读者可感知的冲突与追读动力。',
      '## 前台钩子（须含异常信息差） / ## 读者期待 / ## 后台设定 / ## 开篇第一页建议 / ## 评分与改进',
      '## 评分卡（钩子强度/信息差/代价可见性，各0-100）',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  },
  microinnovation: {
    label: '微创新',
    step: 'incubator_microinnovation',
    system: [
      '约90%成熟套路+10%差异化，但创新点必须附带「创新代价」与「失败风险」。',
      '## 可保留套路 / ## 创新点 / ## 金手指(能力+限制+反噬) / ## 创新比例 / ## 风险提示 / ## 应避开的俗套',
      INCUBATOR_ANTI_MEDIOCRITY
    ].join('\n')
  }
}

export const INCUBATOR_ANALYSIS_KEYS = Object.keys(INCUBATOR_ANALYSIS_PROMPTS)

/** 过程干预：微指令 system */
export const INCUBATOR_MICRO_INSTRUCT_SYSTEM = [
  '你是苛刻的小说结构编辑。根据微指令修改内容。',
  '修改时必须保持或增强冲突张力；不得把尖锐冲突改成温和妥协。',
  '只输出修改后的完整内容，不要解释。',
  INCUBATOR_ANTI_MEDIOCRITY
].join('\n')

export const INCUBATOR_REJECT_RETRY_SUFFIX =
  '请重新生成，且必须比上一版更极端、更尖锐、更出人意料；避免安全解与套路化表达。'

export const INCUBATOR_AB_VARIANTS_USER_SUFFIX = [
  '请生成三个版本，用 JSON 输出：',
  'A=最大冲突张力版（高风险高回报）；B=最大情感密度版（高记忆点高余韵）；C=融合建议（取A抓力+B余味）。',
  '各版 summary 约 200-350 字，须含不可逆代价。',
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

/** 将诊断报告中的「修复动作」落到六槽（二次 LLM，输出 JSON） */
export const INCUBATOR_DIAGNOSE_APPLY_SYSTEM = [
  '你是主线编排编辑。根据「诊断方向」报告中的 ## 修复动作，将修复融入对应槽位的现有内容。',
  '规则：',
  '1) 只处理报告中明确、可写入槽位的修复项；不要臆造新剧情。',
  '2) text 是修复后该槽位的**完整内容**——把修复与原文合并，保留原有好的部分，修正有问题的部分，使全文连贯。',
  '3) 若该槽位原来为空，text 就是全新内容。',
  '4) 每条 patch 的 text 为可直接替换进槽位的 Markdown 段落（100-500字）。',
  '5) slotKey 只能是：hook、core_conflict、role_engine、world_rules、emotion_curve、ending_image。',
  INCUBATOR_ANTI_MEDIOCRITY,
  '只输出一个 JSON 对象，禁止其它文字：',
  '{"patches":[{"slotKey":"hook","text":"合并后的完整槽位内容..."}]}',
  '无合适修复时输出 {"patches":[]}'
].join('\n')

export function buildDiagnoseApplyUserPrompt(
  seed: string,
  slots: Partial<Record<IncubatorSlotKey, string>>,
  diagnoseReport: string
): string {
  const block = buildSlotAnchorBlock(slots, [...INCUBATOR_SLOT_KEYS])
  const parts = [
    '【创作种子】',
    seed.trim(),
    '',
    '【当前主线六槽】',
    block || '（各槽均为空）',
    '',
    '【诊断方向报告（请只执行其中 ## 修复动作）】',
    diagnoseReport.trim()
  ]
  return parts.join('\n')
}

export const INCUBATOR_SYNTHESIZE_SYSTEM = [
  '你是主线统合编辑。将下列六个槽位内容融合为一份连贯的主线摘要。',
  '要求：统一称谓与因果链；消除重复；保留所有不可逆代价与反常识钩子；不得弱化冲突。',
  '输出 Markdown，且仅包含以下两节：',
  '## 统合主线摘要（400-800字，因果清晰、可读性强）',
  '## 质量评分卡（吸引力/差异化/记忆点/冲突张力/连贯性，各0-100）'
].join('\n')
