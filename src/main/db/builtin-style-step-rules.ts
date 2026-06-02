import type { StyleStepRules } from '../../shared/style-step-rules'

/** 内置文风的分步规则，按名称索引 */
export const BUILTIN_STYLE_STEP_RULES: Record<string, StyleStepRules> = {
  '现代网文-爽文': {
    identity: {
      emotional_core: ['爽感', '优越感', '掌控感'],
      target_reader: '男频18-35岁',
      style_keywords: ['快节奏', '高反馈', '强冲突']
    },
    decision_rules: [
      '当 当前场景无冲突 → 立即创建冲突',
      '当 连续2个场景无奖励 → 插入打脸/升级/获宝等奖励',
      '当 主角被动超过2次 → 强制主角主动行动',
      '当 章节末尾无悬念 → 添加新威胁或信息缺口'
    ],
    pacing_rules: {
      conflict_interval: '300-800字',
      payoff_interval: '500-1500字',
      chapter_end_must: ['新冲突', '实力展示', '悬念'],
      emotion_loop: ['压抑/挑衅', '冲突升级', '碾压爆发', '打脸奖励']
    },
    quality_checklist: [
      '本章是否有至少1次冲突？',
      '主角是否主动推进剧情？',
      '是否出现奖励/升级/打脸？',
      '章节末是否留下悬念或钩子？',
      '对话是否占比超过40%？',
      '是否有连续超过3段无事件的描写？'
    ]
  },
  '传统文学-细腻': {
    identity: {
      emotional_core: ['共鸣', '细腻', '留白'],
      target_reader: '文艺向、情感向读者',
      style_keywords: ['慢节奏', '心理刻画', '意境']
    },
    decision_rules: [
      '当 情感转折缺乏铺垫 → 补充细节或回忆',
      '当 对话直抒胸臆 → 改为动作/环境暗示',
      '当 场景切换过快 → 增加过渡与氛围描写'
    ],
    pacing_rules: {
      conflict_interval: '1500-3000字',
      payoff_interval: '2000-4000字',
      chapter_end_must: ['情感余韵', '意象收束'],
      emotion_loop: ['日常细节', '暗流涌动', '情感爆发', '沉静回味']
    },
    quality_checklist: [
      '情感是否通过细节而非形容词直说？',
      '是否有留白让读者参与想象？',
      '角色对话是否体现性格差异？',
      '节奏是否张弛有度？'
    ]
  },
  '悬疑推理-冷峻': {
    identity: {
      emotional_core: ['好奇', '紧张', '智力优越'],
      target_reader: '悬疑/推理爱好者',
      style_keywords: ['冷峻', '信息差', '伏笔']
    },
    decision_rules: [
      '当 解释设定一次性倾倒 → 改为渐进式释放',
      '当 无新线索出现 → 埋入细节或误导信息',
      '当 转折缺乏铺垫 → 回溯前文补伏笔',
      '当 角色信息对等 → 制造信息差'
    ],
    pacing_rules: {
      conflict_interval: '800-1500字',
      payoff_interval: '1500-2500字',
      chapter_end_must: ['新线索', '新疑问', '危机升级'],
      emotion_loop: ['平静表象', '异常信号', '推理推进', '反转冲击']
    },
    quality_checklist: [
      '本章是否推进了谜团或线索？',
      '是否有逻辑自洽的因果链？',
      '伏笔是否自然而非生硬？',
      '章末是否留下未解问题？'
    ]
  },
  '轻小说-活泼': {
    identity: {
      emotional_core: ['轻松', '趣味', '陪伴感'],
      target_reader: '轻小说/日常向读者',
      style_keywords: ['活泼', '吐槽', '角色鲜明']
    },
    decision_rules: [
      '当 场景过于严肃 → 插入角色吐槽或日常细节',
      '当 对话平淡 → 强化角色语言特色',
      '当 节奏拖沓 → 压缩过渡，直达笑点或转折'
    ],
    pacing_rules: {
      conflict_interval: '600-1200字',
      payoff_interval: '1000-1800字',
      chapter_end_must: ['小悬念', '角色互动钩子'],
      emotion_loop: ['日常', '小麻烦', '化解/吐槽', '温馨收束']
    },
    quality_checklist: [
      '对话是否有角色辨识度？',
      '是否有轻松有趣的细节？',
      '章末是否让人想继续看？'
    ]
  },
  '历史正剧-厚重': {
    identity: {
      emotional_core: ['格局', '厚重', '命运感'],
      target_reader: '历史/史诗向读者',
      style_keywords: ['典雅', '考据', '庙堂江湖']
    },
    decision_rules: [
      '当 人物言行脱离时代 → 调整称谓与礼仪',
      '当 冲突缺乏政治/利益维度 → 补充势力博弈',
      '当 节奏过快 → 重要节点放慢，增加铺垫'
    ],
    pacing_rules: {
      conflict_interval: '1200-2500字',
      payoff_interval: '2000-3500字',
      chapter_end_must: ['局势变化', '人物抉择'],
      emotion_loop: ['蓄势', '博弈', '决断', '余波']
    },
    quality_checklist: [
      '语言是否符合时代语境？',
      '冲突是否有利益/权力层面的动机？',
      '重要转折是否有足够铺垫？'
    ]
  },
  '科幻硬核-冷感': {
    identity: {
      emotional_core: ['好奇', '敬畏', '思辨'],
      target_reader: '硬科幻读者',
      style_keywords: ['克制', '逻辑', '概念清晰']
    },
    decision_rules: [
      '当 新概念未解释 → 首次出现时简要说明机制',
      '当 情感描写过多 → 收束为行动与细节',
      '当 科技设定前后矛盾 → 对齐世界观规则'
    ],
    pacing_rules: {
      conflict_interval: '1000-2000字',
      payoff_interval: '1500-2800字',
      chapter_end_must: ['新发现', '新风险', '伦理困境'],
      emotion_loop: ['探索', '认知冲击', '应对', '更大未知']
    },
    quality_checklist: [
      '设定是否逻辑自洽？',
      '新概念是否解释清楚？',
      '叙述是否克制冷静？'
    ]
  },
  '古风仙侠-飘逸': {
    identity: {
      emotional_core: ['逍遥', '快意', '境界感'],
      target_reader: '修仙/武侠读者',
      style_keywords: ['飘逸', '意境', '境界']
    },
    decision_rules: [
      '当 打斗缺乏节奏 → 招式与动作呼应',
      '当 写景空洞 → 加入意象（月、剑、云等）',
      '当 境界突破无铺垫 → 补充修炼/感悟线索'
    ],
    pacing_rules: {
      conflict_interval: '800-1500字',
      payoff_interval: '1200-2200字',
      chapter_end_must: ['境界契机', '新敌/新地图', '悬念'],
      emotion_loop: ['修炼/游历', '遇阻', '顿悟/破境', '更大世界']
    },
    quality_checklist: [
      '语言是否有古典韵味且可读？',
      '打斗是否有节奏感？',
      '境界/功法设定是否一致？'
    ]
  },
  '都市情感-细腻': {
    identity: {
      emotional_core: ['共鸣', '温暖', '真实'],
      target_reader: '都市言情/现实向读者',
      style_keywords: ['生活质感', '情感真实', '细节']
    },
    decision_rules: [
      '当 情感直说 → 改为小动作/沉默/环境暗示',
      '当 场景缺乏生活感 → 补充都市细节',
      '当 配角仅服务主角 → 给配角独立诉求'
    ],
    pacing_rules: {
      conflict_interval: '1200-2200字',
      payoff_interval: '1800-3000字',
      chapter_end_must: ['情感悬念', '关系变化'],
      emotion_loop: ['日常', '摩擦', '爆发/和解', '余温']
    },
    quality_checklist: [
      '场景是否有生活质感？',
      '情感是否通过细节表达？',
      '对话是否贴近当代口语？'
    ]
  },
  '幽默吐槽-网感': {
    identity: {
      emotional_core: ['欢乐', '解压', '意外'],
      target_reader: '搞笑/吐槽向读者',
      style_keywords: ['梗', '快节奏', '反讽']
    },
    decision_rules: [
      '当 连续无笑点 → 插入吐槽/夸张类比/意外转折',
      '当 笑点与情节脱节 → 让笑点推动或揭示情节',
      '当 节奏拖沓 → 删繁就简，加快信息密度'
    ],
    pacing_rules: {
      conflict_interval: '400-900字',
      payoff_interval: '600-1400字',
      chapter_end_must: ['笑点', '反转', '悬念'],
      emotion_loop: ['铺垫', '误会/反差', '爆发笑点', '新梗预告']
    },
    quality_checklist: [
      '本章是否有有效笑点？',
      '笑点是否服务于情节？',
      '节奏是否够快、段落够短？'
    ]
  },
  '童话寓言-温暖': {
    identity: {
      emotional_core: ['温暖', '希望', '寓意'],
      target_reader: '全年龄读者',
      style_keywords: ['简洁', '画面感', '寓意']
    },
    decision_rules: [
      '当 句子过长 → 拆分为短句',
      '当 寓意说教 → 融入情节自然呈现',
      '当 危机无解 → 保留化解可能与希望'
    ],
    pacing_rules: {
      conflict_interval: '800-1500字',
      payoff_interval: '1000-2000字',
      chapter_end_must: ['小启示', '新冒险预告'],
      emotion_loop: ['平静', '考验', '领悟', '温暖收束']
    },
    quality_checklist: [
      '语言是否简洁适合朗读？',
      '场景是否有画面感？',
      '是否留有希望与寓意？'
    ]
  }
}

export function getBuiltinStepRulesJson(name: string): string | undefined {
  const rules = BUILTIN_STYLE_STEP_RULES[name]
  return rules ? JSON.stringify(rules) : undefined
}
