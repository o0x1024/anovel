/**
 * 词表预设集合 —— 来源于真实人类小说的词汇统计
 *
 * 提取逻辑：统计 AI 高频词在人类小说中的替代写法，
 * 收集那些 AI 几乎不用、但人类作者常用的低频同义表达。
 * 替换后可从 token 分布层面降低 AI 检测命中率。
 */

export interface WordTablePreset {
  id: string
  name: string
  description: string
  entries: Array<{ type: 'word' | 'pattern'; source: string; target: string }>
}

/**
 * 预设 A：古典仙侠风 —— 源自《凡人修仙传》（忘语）
 *
 * 用词特征：半文半白、节奏古朴、少用现代书面语连接词、
 * 大量使用"便""却""倒"等古白话虚词替代 AI 偏好的"然而""因此"。
 */
const PRESET_FANREN: WordTablePreset = {
  id: 'fanren',
  name: '古典仙侠（凡人修仙传）',
  description: '从《凡人修仙传》提取的古典仙侠风格替换词，适合仙侠/武侠/古风小说',
  entries: [
    // ── 连接词/过渡词 ──
    { type: 'word', source: '然而', target: '可|却|偏偏' },
    { type: 'word', source: '但是', target: '可|不过|只是' },
    { type: 'word', source: '因此', target: '如此一来|这样一来|当下' },
    { type: 'word', source: '于是', target: '便|当即|当下' },
    { type: 'word', source: '同时', target: '一边……一边|与此' },
    { type: 'word', source: '此外', target: '' },
    { type: 'word', source: '尽管', target: '纵然|即便|就算' },
    { type: 'word', source: '虽然', target: '虽说|固然' },
    { type: 'word', source: '而且', target: '更兼|况且|何况' },
    { type: 'word', source: '所以', target: '故而|这才|也就' },
    { type: 'word', source: '毕竟', target: '说到底|到底|终究' },

    // ── 动作/神态描写 ──
    { type: 'word', source: '微微一笑', target: '嘴角一翘|淡然一笑|笑了一笑' },
    { type: 'word', source: '皱了皱眉', target: '眉头一皱|眉梢一挑|眉头不禁一皱' },
    { type: 'word', source: '缓缓说道', target: '不慌不忙的说道|慢悠悠的说道|慢吞吞地开口' },
    { type: 'word', source: '轻声说', target: '低声道|小声道|喃喃道' },
    { type: 'word', source: '沉声说道', target: '冷冷的说道|森然说道|肃然地说道' },
    { type: 'word', source: '喃喃自语', target: '喃喃的自语道|嘴里低声念叨|暗暗想道' },
    { type: 'word', source: '点了点头', target: '微微点头|颔首|应了一声' },
    { type: 'word', source: '摇了摇头', target: '把头摇得跟拨浪鼓一样|微微摇头|将头一摇' },
    { type: 'word', source: '面无表情', target: '面色如常|脸上什么表情都没有|神色不变' },
    { type: 'word', source: '神色一变', target: '面色微变|脸色骤然一变|不禁面色一沉' },
    { type: 'word', source: '深吸一口气', target: '吸了口气|长出了一口气|倒吸了一口凉气' },
    { type: 'word', source: '嘴角上扬', target: '嘴角泛起一丝讥笑|嘴角升起一丝冷笑|嘴角微翘' },
    { type: 'word', source: '眼中闪过', target: '眼里闪过|目中流露出|眼底掠过' },
    { type: 'word', source: '转身离去', target: '转身飘然而去|回身就走|拂袖而去' },
    { type: 'word', source: '陷入沉思', target: '沉吟了起来|思量了一下|稍微想了想' },

    // ── 程度/频率副词 ──
    { type: 'word', source: '非常', target: '极|甚是|颇为' },
    { type: 'word', source: '十分', target: '颇为|极|甚' },
    { type: 'word', source: '立刻', target: '当即|急忙|连忙' },
    { type: 'word', source: '迅速', target: '飞快|急速|麻利' },
    { type: 'word', source: '逐渐', target: '渐渐|慢慢|一点一点' },
    { type: 'word', source: '忽然', target: '猛然|蓦然|倏的' },
    { type: 'word', source: '显然', target: '看来|想必|分明' },
    { type: 'word', source: '似乎', target: '好像|仿佛|看起来' },

    // ── 感知/心理 ──
    { type: 'word', source: '意识到', target: '回过味来|恍然大悟|终于明白' },
    { type: 'word', source: '感受到', target: '感应到|觉出' },
    { type: 'word', source: '注意到', target: '留意到|瞥见|发觉' },
    { type: 'word', source: '震惊', target: '大吃一惊|愕然|面露骇然之色' },
    { type: 'word', source: '惊讶', target: '吃了一惊|愕然|有些意外' },
    { type: 'word', source: '不由自主', target: '情不自禁|不知不觉|下意识的' },
    { type: 'word', source: '犹豫不决', target: '拿不定主意|犹豫了一下|心中七上八下' },

    // ── 环境/氛围 ──
    { type: 'word', source: '一片寂静', target: '静得可怕|四周无声|万籁俱寂' },
    { type: 'word', source: '气氛紧张', target: '气氛也突然变得紧张起来|空气仿佛凝固了' },

    // ── 句式模板 ──
    { type: 'pattern', source: '他的目光...落在...上', target: '他直直望向{2}|他把目光投向{2}' },
    { type: 'pattern', source: '一股...涌上心头', target: '心中{1}大盛|一阵{1}油然而生' },
    { type: 'pattern', source: '虽然...但是', target: '固然{1}，但{2}|{1}是不假，可{2}' },
    { type: 'pattern', source: '不仅...而且', target: '不但{1}，更{2}|{1}不说，{2}' },
  ],
}

/**
 * 预设 B：现代都市风 —— 源自《我在精神病院学斩神》（三九音域）
 *
 * 用词特征：现代口语化、短句节奏快、镜头感强、
 * 大量使用直白的动作描写和情绪外放的表达。
 */
const PRESET_ZHANGSHEN: WordTablePreset = {
  id: 'zhanshen',
  name: '现代都市（我在精神病院学斩神）',
  description: '从《我在精神病院学斩神》提取的现代都市风格替换词，适合都市/悬疑/轻小说',
  entries: [
    // ── 连接词/过渡词 ──
    { type: 'word', source: '然而', target: '可|但|结果' },
    { type: 'word', source: '但是', target: '不过|可|只是' },
    { type: 'word', source: '因此', target: '所以|这下|就这样' },
    { type: 'word', source: '于是', target: '然后|接着|就' },
    { type: 'word', source: '此外', target: '' },
    { type: 'word', source: '尽管', target: '就算|哪怕|即便' },
    { type: 'word', source: '所以', target: '这才|也就|结果' },

    // ── 动作/神态（现代口语化） ──
    { type: 'word', source: '微微一笑', target: '嘴角勾起一个弧度|笑了一声|咧嘴一笑' },
    { type: 'word', source: '皱了皱眉', target: '眉头微微皱起|拧了拧眉|眉头一跳' },
    { type: 'word', source: '缓缓说道', target: '缓缓开口|幽幽开口|不紧不慢的说' },
    { type: 'word', source: '沉声说', target: '低声开口|冷声道|闷声道' },
    { type: 'word', source: '点了点头', target: '微微点头|嗯了一声|点头' },
    { type: 'word', source: '摇了摇头', target: '摆了摆手|摇头|晃了晃脑袋' },
    { type: 'word', source: '转身离去', target: '头也不回的走了|转身就走|扭头就走' },
    { type: 'word', source: '面无表情', target: '面色平静|脸上没什么表情|一脸淡然' },
    { type: 'word', source: '深吸一口气', target: '深吸了口气|喘了一口气|长舒一口气' },
    { type: 'word', source: '神色一变', target: '脸色一变|面色一僵|愣了一下' },
    { type: 'word', source: '目光凝重', target: '眼神沉了下来|神色有些凝重|表情严肃了起来' },
    { type: 'word', source: '眼中闪过', target: '眼底掠过|眼中浮现出|眸中闪了一下' },
    { type: 'word', source: '嘴角上扬', target: '嘴角微微一勾|嘴角一撇|嘴唇弯了弯' },

    // ── 反应/情绪（更直白） ──
    { type: 'word', source: '震惊', target: '整个人都呆住了|人直接傻了|惊得说不出话' },
    { type: 'word', source: '惊讶', target: '一愣|一怔|吃了一惊' },
    { type: 'word', source: '意识到', target: '反应过来|回过神来|猛然想到' },
    { type: 'word', source: '注意到', target: '瞅见|发现|目光落在' },
    { type: 'word', source: '犹豫不决', target: '有些踌躇|犹豫了一下|迟疑了片刻' },
    { type: 'word', source: '不由自主', target: '不由得|下意识|鬼使神差' },
    { type: 'word', source: '陷入沉思', target: '沉默了片刻|陷入了沉默|怔怔的想着' },
    { type: 'word', source: '若有所思', target: '像是在想什么|眉头微微皱起|出了一会儿神' },

    // ── 程度/频率副词 ──
    { type: 'word', source: '非常', target: '特别|很|极其' },
    { type: 'word', source: '十分', target: '相当|很|特别' },
    { type: 'word', source: '立刻', target: '当即|马上|一下' },
    { type: 'word', source: '迅速', target: '飞快|一下子|唰的一下' },
    { type: 'word', source: '逐渐', target: '慢慢|一点点|渐渐' },
    { type: 'word', source: '忽然', target: '突然|猛地|刷的一下' },
    { type: 'word', source: '显然', target: '明显|看得出|一看就知道' },

    // ── 环境/氛围 ──
    { type: 'word', source: '一片寂静', target: '死寂无声|安静得可怕|整个空间陷入死寂' },
    { type: 'word', source: '气氛紧张', target: '气氛一下子紧绷起来|空气都凝固了' },
    { type: 'word', source: '空气中弥漫着', target: '四周充斥着|到处都是' },

    // ── 句式模板 ──
    { type: 'pattern', source: '他的目光...落在...上', target: '他看向{2}|他盯着{2}' },
    { type: 'pattern', source: '一股...涌上心头', target: '心里一阵{1}|{1}的感觉冒了上来' },
    { type: 'pattern', source: '虽然...但是', target: '就算{1}，可{2}|{1}归{1}，但{2}' },
  ],
}

/**
 * 预设 C：综合通用 —— 融合两种风格的通用替换词
 *
 * 特点：取两部小说中最具代表性的替换，适用于多数题材。
 * 覆盖面更广，但不针对特定文风。
 */
const PRESET_GENERAL: WordTablePreset = {
  id: 'general',
  name: '综合通用',
  description: '融合古典仙侠+现代都市风格的通用替换词表，适用于多数小说题材',
  entries: [
    // ── 连接词（AI 高频 → 人类常用）──
    { type: 'word', source: '然而', target: '可|却|偏偏|不过' },
    { type: 'word', source: '但是', target: '可|不过|只是|偏' },
    { type: 'word', source: '因此', target: '如此一来|这才|这下|当下' },
    { type: 'word', source: '于是', target: '便|然后|接着|当即' },
    { type: 'word', source: '与此同时', target: '就在这时|这当口|恰在此时' },
    { type: 'word', source: '此外', target: '' },
    { type: 'word', source: '不仅如此', target: '' },
    { type: 'word', source: '值得注意的是', target: '' },
    { type: 'word', source: '尤其是', target: '特别是|尤其' },
    { type: 'word', source: '尽管', target: '纵然|即便|就算|哪怕' },
    { type: 'word', source: '虽然', target: '虽说|固然|好歹' },
    { type: 'word', source: '而且', target: '况且|何况|更兼' },
    { type: 'word', source: '毕竟', target: '说到底|到底|终究|不管怎么说' },
    { type: 'word', source: '所以', target: '故而|这才|也就|结果' },

    // ── 动作/神态描写 ──
    { type: 'word', source: '微微一笑', target: '嘴角一弯|咧嘴笑了|淡然一笑|抿嘴一笑' },
    { type: 'word', source: '皱了皱眉', target: '拧了拧眉|眉头一皱|眉心一拧|眉头微微皱起' },
    { type: 'word', source: '缓缓说道', target: '慢悠悠开口|不紧不慢道|幽幽开口|慢吞吞的说' },
    { type: 'word', source: '淡淡地说', target: '随口道|不咸不淡道|平静地说|轻描淡写道' },
    { type: 'word', source: '沉声说道', target: '闷声道|冷冷的说道|低沉着嗓子道' },
    { type: 'word', source: '轻声说', target: '低声道|小声道|嘟囔道' },
    { type: 'word', source: '喃喃自语', target: '嘴里念叨着|暗暗想道|自言自语' },
    { type: 'word', source: '点了点头', target: '微微颔首|嗯了一声|应了一声' },
    { type: 'word', source: '摇了摇头', target: '摆了摆手|将头一摇|晃了晃脑袋' },
    { type: 'word', source: '面无表情', target: '脸上什么表情都没有|面色如常|神色不变' },
    { type: 'word', source: '神色一变', target: '面色微变|脸色骤然一变|愣了一下' },
    { type: 'word', source: '深吸一口气', target: '吸了口气|喘了一下|长出了一口气' },
    { type: 'word', source: '嘴角上扬', target: '嘴角一翘|嘴角微微一勾|撇了下嘴' },
    { type: 'word', source: '眼中闪过', target: '眼底掠过|目中流露出|眸子里闪了一下' },
    { type: 'word', source: '转身离去', target: '转身就走|头也不回的走了|拂袖而去' },
    { type: 'word', source: '陷入沉思', target: '沉吟了起来|愣了一会儿|思量了一下' },
    { type: 'word', source: '若有所思', target: '出了一会儿神|发了一会儿愣|琢磨着什么' },
    { type: 'word', source: '目光深邃', target: '眼底暗沉沉的|目光幽幽的' },
    { type: 'word', source: '目光凝重', target: '眼神沉了下来|表情严肃了起来' },
    { type: 'word', source: '神色复杂', target: '脸色变了变|脸上阴晴不定|一脸复杂' },

    // ── 程度/频率副词 ──
    { type: 'word', source: '非常', target: '极|特别|甚是|格外|怪' },
    { type: 'word', source: '十分', target: '颇为|挺|相当|极' },
    { type: 'word', source: '立刻', target: '当即|急忙|连忙|赶紧|马上' },
    { type: 'word', source: '迅速', target: '飞快|麻溜|一下子' },
    { type: 'word', source: '顿时', target: '一下子|登时|霎时|刷的一下' },
    { type: 'word', source: '逐渐', target: '慢慢|一点一点|渐渐' },
    { type: 'word', source: '忽然', target: '猛然|蓦然|突然|猛地' },
    { type: 'word', source: '显然', target: '看来|分明|明摆着|一看就知道' },
    { type: 'word', source: '似乎', target: '好像|大概|像是|仿佛' },
    { type: 'word', source: '略微', target: '稍稍|有那么一点|微微' },

    // ── 感知/心理 ──
    { type: 'word', source: '意识到', target: '回过味来|恍然|反应过来|琢磨明白' },
    { type: 'word', source: '察觉到', target: '嗅出|感觉出|发觉' },
    { type: 'word', source: '感受到', target: '感觉着|觉出' },
    { type: 'word', source: '注意到', target: '瞅见|留意到|扫到|发现' },
    { type: 'word', source: '震惊', target: '大吃一惊|愕然|整个人都呆住了' },
    { type: 'word', source: '惊讶', target: '吃了一惊|一愣|有些意外' },
    { type: 'word', source: '不由自主', target: '情不自禁|下意识|鬼使神差' },
    { type: 'word', source: '犹豫不决', target: '拿不定主意|犹豫了一下|踌躇了片刻' },

    // ── 环境/氛围 ──
    { type: 'word', source: '一片寂静', target: '静得落针可闻|安静得发慌|死寂无声' },
    { type: 'word', source: '空气中弥漫着', target: '满屋子都是|到处飘着|四周充斥着' },
    { type: 'word', source: '气氛紧张', target: '空气仿佛凝固了|气氛一下子紧绷起来' },
    { type: 'word', source: '夜色笼罩', target: '天色已黑|夜幕降临|天黑透了' },

    // ── 句式模板 ──
    { type: 'pattern', source: '他的目光...落在...上', target: '他瞄了一眼{2}|他看向{2}|他盯着{2}' },
    { type: 'pattern', source: '一股...涌上心头', target: '{1}冒了上来|心里一阵{1}|一阵{1}油然而生' },
    { type: 'pattern', source: '不是...而是', target: '与其说{1}不如说{2}|说到底是{2}' },
    { type: 'pattern', source: '虽然...但是', target: '固然{1}，但{2}|{1}归{1}，可{2}' },
    { type: 'pattern', source: '不仅...而且', target: '不但{1}，更{2}|{1}不说，{2}也' },
    { type: 'pattern', source: '正是因为...所以', target: '因为{1}，这才{2}|就是{1}，所以{2}' },
  ],
}

export const WORDTABLE_PRESETS: WordTablePreset[] = [
  PRESET_GENERAL,
  PRESET_FANREN,
  PRESET_ZHANGSHEN,
]
