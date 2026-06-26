import type { WordTableEntryRow } from '../../../shared/aigc-wordtable-types'

/**
 * 内置 AI 高频词替换表
 * 
 * 原理：AI 文本的核心特征之一是「选择最高概率的词」——即 Top-5 命中率高。
 * 通过将这些高频词替换为低频但语义等价的同义词，可以从 token 级别
 * 改变文本的统计分布，使其偏离 AI 的概率峰值。
 * 
 * 每个条目的 target 用 | 分隔多个候选，运行时随机选取以增加不可预测性。
 */

const BUILTIN_WORD_ENTRIES: Array<{ source: string; target: string }> = [
  // ── 【高危】连接词/过渡词 —— 朱雀实验F4证实：注入连接词使人工特征↓39% ──
  { source: '然而', target: '可|但|不过' },
  { source: '因此', target: '所以|这才|就' },
  { source: '此外', target: '另外|还有' },
  { source: '与此同时', target: '这会儿|这当口' },
  { source: '不仅如此', target: '' },
  { source: '尽管如此', target: '话虽这么说|即便这样' },
  { source: '值得注意的是', target: '' },
  { source: '不难发现', target: '' },
  { source: '由此可见', target: '' },
  { source: '换言之', target: '' },
  { source: '总而言之', target: '' },
  { source: '紧接着', target: '跟着|随后' },
  { source: '随即', target: '转眼|紧跟着' },
  { source: '不禁', target: '' },
  { source: '仿佛', target: '好像|活像|跟' },
  { source: '宛如', target: '好似|活像' },
  { source: '犹如', target: '好像|跟' },

  // ── 动作描写（AI 最常用的动作模板）──
  { source: '微微一笑', target: '嘴角一弯|扯了扯嘴角|咧嘴笑了' },
  { source: '微微皱眉', target: '拧了拧眉|眉头拧起来' },
  { source: '缓缓说道', target: '慢悠悠开口|不紧不慢道' },
  { source: '淡淡地说', target: '随口道|不咸不淡道' },
  { source: '不由得', target: '忍不住|没忍住' },
  { source: '深吸一口气', target: '喘了口粗气|倒吸一口凉气' },
  { source: '目光深邃', target: '眼底暗沉沉的' },
  { source: '神色复杂', target: '脸色变了变' },
  { source: '若有所思', target: '发了一会儿愣|出了神' },

  // ── 【致命】电影镜头链动作词 —— 朱雀F6实验：最强AI指纹 ──
  { source: '缓缓开口', target: '开了口|张嘴说|说道' },
  { source: '缓缓说道', target: '慢悠悠开口|不紧不慢道' },
  { source: '缓缓站起身', target: '站了起来|起了身' },
  { source: '脚步一顿', target: '停了下来|愣了一下' },
  { source: '停下脚步', target: '站住了|不走了' },
  { source: '迈步向前', target: '走了过去|上前几步' },
  { source: '四目相对', target: '两人对视|互相看了一眼' },

  // ── 微动作模板 ──
  { source: '愣在原地', target: '整个人定住了|呆了一呆|脚步一顿' },
  { source: '僵在原地', target: '浑身一僵|身子一凝|整个人钉在那儿' },
  { source: '猛地回魂', target: '这才缓过劲来|回过神|打了个激灵' },
  { source: '猛地偏头', target: '唰地扭过脸|把脸别过去' },
  { source: '目光掠过', target: '瞄了一圈|扫了一眼|打量着' },
  { source: '视线滑开', target: '把目光挪开|眼神飘了开|收回视线' },
  { source: '耳根泛红', target: '耳朵烧起来|耳尖红了|耳根子发烫' },
  { source: '泛起红晕', target: '红了一片|烧红了脸' },
  { source: '嘴角上扬', target: '嘴角一歪|咧了咧嘴|嘴巴弯起来' },
  { source: '嘴角微勾', target: '撇了下嘴|嘴角一弯' },
  { source: '定格了一瞬', target: '停了一拍|顿了一下|卡了一秒' },
  { source: '翻了个白眼', target: '斜了一眼|撂了个眼刀子|眼皮一翻' },
  { source: '眼睫一垂', target: '眼皮一耷拉|低了低眼' },
  { source: '指尖僵在', target: '手一顿，悬在|手指头停在|手指愣在' },
  { source: '神色一变', target: '脸色唰地白了|面皮一紧|脸色变了变' },
  { source: '眼中闪过', target: '眼底掠过|目光一闪' },
  { source: '面无表情', target: '脸上什么表情都没有|一张死人脸|面色平平' },
  { source: '轻声说', target: '小声嘟囔|低声道|压低嗓子说' },
  { source: '沉声说道', target: '闷声道|哑着嗓子开口|低着声音说' },
  { source: '喃喃自语', target: '嘴里碎碎念|自个儿念叨|嘟囔了一句' },
  { source: '点了点头', target: '嗯了一声|应了一声|把头一点' },
  { source: '摇了摇头', target: '把头一甩|晃了下脑袋|摆了摆手' },
  { source: '转身离去', target: '扭头就走|一转身走了|头也不回地走了' },
  { source: '陷入沉思', target: '出了一会儿神|琢磨了半天|发起了呆' },
  { source: '目光凝重', target: '眼神沉了下来|表情严肃起来' },
  { source: '皱了皱眉', target: '眉头拧了一下|蹙了下眉' },

  // ── "像"字比喻（AI 最偏好的比喻结构）──
  { source: '像被按了暂停键', target: '一下子卡住了|整个人顿住' },
  { source: '像是被情绪染深了', target: '颜色好像重了些' },
  { source: '像被钉住了似的', target: '跟生了根似的|像长在那了' },
  { source: '像是被什么击中', target: '就跟挨了一棒子一样' },

  // ── 程度副词（AI 偏好中性、安全的程度词）──
  { source: '迅速', target: '麻溜|飞快|赶紧' },
  { source: '立刻', target: '赶忙|当即|二话不说' },
  { source: '顿时', target: '一下子|登时|霎时' },
  { source: '逐渐', target: '慢慢|一点一点' },
  { source: '略微', target: '稍稍|有那么一点' },
  { source: '十分', target: '挺|相当|怪' },
  { source: '非常', target: '特别|格外|忒' },
  { source: '忽然', target: '冷不丁|猛不防|冷不防' },
  { source: '似乎', target: '像是|好像|八成' },
  { source: '显然', target: '明摆着|一看就|分明' },

  // ── 感知动词（AI 喜欢精确描述内心活动）──
  { source: '意识到', target: '回过味来|恍然|琢磨明白' },
  { source: '察觉到', target: '嗅出|感觉出' },
  { source: '感受到', target: '感觉着' },
  { source: '注意到', target: '瞅见|留意到|扫到' },
  { source: '震惊', target: '吓了一跳|整个人都傻了|惊得不轻' },
  { source: '惊讶', target: '吃了一惊|一愣|没想到' },
  { source: '不由自主', target: '鬼使神差|下意识|没过脑子' },
  { source: '犹豫不决', target: '拿不定主意|心里打鼓|犯了嘀咕' },

  // ── 环境/氛围描写模板 ──
  { source: '一片寂静', target: '静得落针可闻|安静得发慌' },
  { source: '气氛一时有些', target: '场面一下子变得' },
  { source: '空气中弥漫着', target: '满屋子都是|到处飘着' },
  { source: '夜色笼罩', target: '天黑透了|入了夜' },
  { source: '气氛紧张', target: '空气发紧|场面绷起来了' },

  // ── AI 叙事套话/节奏填充 ──
  { source: '没等她开口', target: '她话还没出口|她嘴刚张开' },
  { source: '没等他开口', target: '他话还没出口|他嘴刚张开' },
  { source: '无声归位', target: '搁回了原处|放回去了' },
  { source: '轻得像自言自语', target: '声音小得跟蚊子哼似的|几乎听不见' },
  { source: '快步从她身旁挤过去', target: '从她身边蹭过去|侧身闪了出去' },
]

const BUILTIN_PATTERN_ENTRIES: Array<{ source: string; target: string }> = [
  // ── 【致命】电影镜头链 —— 朱雀实验F6证实：注入镜头链使人工特征↓81% ──
  { source: '目光...落在...上', target: '瞄了一眼{2}|扫了眼{2}|盯着{2}' },
  { source: '目光...扫过...', target: '瞅了一圈{1}|打量着{1}' },
  { source: '视线...移到...', target: '又看向{2}|瞟了一眼{2}' },
  { source: '嘴角微微...上扬', target: '咧了咧嘴|嘴巴一弯' },
  { source: '缓缓...回过头', target: '扭过脸|转过身子' },

  // ── 【中危】模板情感句/总结收束句 —— 朱雀实验F1/F5证实 ──
  { source: '一股...涌上心头', target: '{1}冒了上来|心里一阵{1}' },
  { source: '心中涌起...', target: '心头一{1}|{1}涌上来' },
  { source: '眼中闪过一丝...', target: '眼底有点{1}|眼神带上了{1}' },
  { source: '这一刻...明白了...', target: '' },
  { source: '或许...这便是...', target: '' },

  // ── 句式模板 ──
  { source: '不是...而是', target: '{2}|{1}不重要，{2}' },
  { source: '虽然...但是', target: '{1}归{1}，可{2}|就算{1}，{2}' },
]

export const BUILTIN_ANTI_AI_VOCAB: WordTableEntryRow[] = [
  ...BUILTIN_WORD_ENTRIES.map((entry, idx) => ({
    id: -(idx + 1),
    type: 'word',
    source: entry.source,
    target: entry.target,
    enabled: 1,
    create_time: '',
    update_time: '',
  })),
  ...BUILTIN_PATTERN_ENTRIES.map((entry, idx) => ({
    id: -(BUILTIN_WORD_ENTRIES.length + idx + 1),
    type: 'pattern',
    source: entry.source,
    target: entry.target,
    enabled: 1,
    create_time: '',
    update_time: '',
  })),
]

export type { WordTableEntryRow }
