export interface GenreNode {
  id: string
  label: string
  children: string[]
}

export type WorldviewCheckSeverity = 'blocking' | 'warning'

export interface WorldviewCheckItem {
  id: string
  label: string
  question: string
  severity: WorldviewCheckSeverity
}

export interface GenreCheckProfile {
  required: string[]
  extra: string[]
}

export const GENRE_WORLDVIEW_CONFIG_VERSION = '1.0.0'

export const GENRE_TREE: readonly GenreNode[] = [
  {
    id: 'fantasy',
    label: '玄幻奇幻',
    children: ['东方玄幻', '西方奇幻', '黑暗奇幻', '史诗奇幻', '低魔奇幻', '神话重构', '克苏鲁奇幻']
  },
  {
    id: 'xianxia',
    label: '仙侠修真',
    children: ['传统修真', '凡人流', '宗门流', '散修流', '道诡仙侠', '洪荒封神', '国风神话']
  },
  {
    id: 'scifi',
    label: '科幻',
    children: ['硬科幻', '软科幻', '太空歌剧', '赛博朋克', '后启示录', '时间旅行', '生物科技', '机甲科幻']
  },
  {
    id: 'urban',
    label: '都市',
    children: ['都市异能', '都市修仙', '商战资本', '职场成长', '现实群像', '神豪系统', '行业文']
  },
  {
    id: 'history',
    label: '历史',
    children: ['历史正剧', '架空历史', '穿越历史', '宫廷政治', '王朝争霸', '历史军事', '历史悬疑']
  },
  {
    id: 'military',
    label: '军事战争',
    children: ['现代战争', '特种作战', '谍战反恐', '末日战争', '冷兵器战争', '战争群像']
  },
  {
    id: 'mystery',
    label: '悬疑推理',
    children: ['本格推理', '社会派推理', '刑侦法医', '密室诡计', '心理推理', '反转谜案']
  },
  {
    id: 'crime',
    label: '犯罪黑帮',
    children: ['警匪对抗', '黑帮权谋', '卧底博弈', '犯罪心理', '司法攻防', '越狱逃亡']
  },
  {
    id: 'horror',
    label: '恐怖惊悚',
    children: ['中式恐怖', '规则怪谈', '灵异民俗', '生存惊悚', '心理惊悚', '超自然恐怖', '悬疑恐怖']
  },
  {
    id: 'adventure',
    label: '冒险生存',
    children: ['荒野生存', '秘境探险', '古墓遗迹', '海洋冒险', '灾难求生', '团队闯关']
  },
  {
    id: 'game',
    label: '游戏电竞',
    children: ['电竞职业', '网游升级', '全息游戏', '游戏异界', '副本闯关', '战术竞技']
  },
  {
    id: 'infinite',
    label: '无限流副本流',
    children: ['无限轮回', '规则副本', '怪谈副本', '主神流', '任务博弈', '空间流']
  },
  {
    id: 'isekai',
    label: '异世界穿越',
    children: ['异世界转生', '魂穿身穿', '多世界穿梭', '文明改造', '回归都市']
  },
  {
    id: 'apocalypse',
    label: '末日废土',
    children: ['丧尸末日', '灾变废土', '资源争夺', '文明重建', '避难所经营', '末日科幻']
  },
  {
    id: 'wuxia',
    label: '武侠江湖',
    children: ['传统武侠', '新武侠', '江湖权谋', '门派恩怨', '朝堂江湖', '侠义复仇']
  },
  {
    id: 'romance',
    label: '言情',
    children: ['现代言情', '古代言情', '仙侠言情', '豪门婚恋', '先婚后爱', '破镜重圆', '甜宠虐恋']
  },
  {
    id: 'female_growth',
    label: '女性成长',
    children: ['大女主成长', '事业线女性文', '宫斗宅斗', '女性群像', '情感治愈', '现实女性题材']
  },
  {
    id: 'male_growth',
    label: '男性成长',
    children: ['升级流', '领主流', '经营流', '权谋流', '复仇流', '热血逆袭', '兄弟群像']
  },
  {
    id: 'campus',
    label: '青春校园',
    children: ['校园恋爱', '成长疼痛', '竞技校园', '社团群像', '毕业过渡']
  },
  {
    id: 'family',
    label: '家庭伦理',
    children: ['婚姻家庭', '代际冲突', '原生家庭', '现实民生', '情感救赎']
  },
  {
    id: 'literary',
    label: '文艺纯文学',
    children: ['现实主义', '先锋实验', '意识流', '黑色幽默', '荒诞寓言', '短篇集']
  },
  {
    id: 'light_novel',
    label: '轻小说二次元',
    children: ['日轻风', '校园奇幻', '恋爱喜剧', '异能战斗', '宅系日常']
  },
  {
    id: 'children',
    label: '少儿幻想',
    children: ['成长冒险', '童话改写', '教育向故事', '少年热血']
  },
  {
    id: 'diverse_relationship',
    label: '多元关系',
    children: ['现代耽美', '古风耽美', '百合', '双强关系', '多元亲密关系']
  },
  {
    id: 'cross_genre',
    label: '跨题材融合',
    children: ['科幻悬疑', '玄幻权谋', '都市恐怖', '言情推理', '历史奇幻', '末日经营']
  }
]

export const WORLDVIEW_CHECKS: readonly WorldviewCheckItem[] = [
  {
    id: 'rule_enforceability',
    label: '规则可执行性',
    question: '规则是否可验证、可执行、可追责？',
    severity: 'blocking'
  },
  {
    id: 'cost_irreversibility',
    label: '代价不可逆性',
    question: '关键能力/选择是否带来真实且不可逆代价？',
    severity: 'blocking'
  },
  {
    id: 'conflict_engine',
    label: '冲突推进引擎',
    question: '世界规则是否持续逼迫主角做困难选择？',
    severity: 'blocking'
  },
  {
    id: 'power_structure',
    label: '秩序与权力结构',
    question: '谁在维持秩序，谁从现有规则中获利？',
    severity: 'warning'
  },
  {
    id: 'information_asymmetry',
    label: '信息不对称',
    question: '谁知道真相，谁被误导，这种差异是否推动剧情？',
    severity: 'warning'
  },
  {
    id: 'edge_cases',
    label: '边界案例',
    question: '极端场景下规则是否仍自洽（至少3个边界案例）？',
    severity: 'warning'
  },
  {
    id: 'societal_impact',
    label: '社会承载性',
    question: '普通人、制度、舆论是否会被世界观波及？',
    severity: 'warning'
  },
  {
    id: 'post_break_order',
    label: '破局后新秩序',
    question: '结局后规则是否重构，是否引出新风险？',
    severity: 'warning'
  }
]

export const GENRE_CHECK_PROFILES: Record<string, GenreCheckProfile> = {
  fantasy: {
    required: ['rule_enforceability', 'cost_irreversibility', 'conflict_engine'],
    extra: ['power_structure', 'edge_cases']
  },
  xianxia: {
    required: ['rule_enforceability', 'cost_irreversibility', 'conflict_engine'],
    extra: ['information_asymmetry', 'post_break_order']
  },
  scifi: {
    required: ['rule_enforceability', 'cost_irreversibility', 'conflict_engine'],
    extra: ['societal_impact', 'edge_cases']
  },
  urban: {
    required: ['rule_enforceability', 'cost_irreversibility', 'conflict_engine'],
    extra: ['societal_impact', 'power_structure']
  },
  horror: {
    required: ['rule_enforceability', 'cost_irreversibility', 'conflict_engine'],
    extra: ['information_asymmetry', 'edge_cases']
  },
  mystery: {
    required: ['rule_enforceability', 'conflict_engine', 'information_asymmetry'],
    extra: ['edge_cases', 'societal_impact']
  },
  default: {
    required: ['rule_enforceability', 'cost_irreversibility', 'conflict_engine'],
    extra: ['power_structure', 'information_asymmetry', 'edge_cases', 'societal_impact', 'post_break_order']
  }
}

const GENRE_ID_SET = new Set(GENRE_TREE.map(g => g.id))
const WORLDVIEW_CHECK_MAP = new Map(WORLDVIEW_CHECKS.map(c => [c.id, c]))

export function isGenreId(value: string): boolean {
  return GENRE_ID_SET.has(value)
}

export function getGenreNode(genreId: string): GenreNode | null {
  return GENRE_TREE.find(g => g.id === genreId) ?? null
}

export function getChecksByGenre(genreId?: string): {
  genreId: string
  profile: GenreCheckProfile
  required: WorldviewCheckItem[]
  extra: WorldviewCheckItem[]
  all: WorldviewCheckItem[]
} {
  const resolvedGenreId =
    genreId && GENRE_CHECK_PROFILES[genreId]
      ? genreId
      : 'default'
  const profile = GENRE_CHECK_PROFILES[resolvedGenreId] ?? GENRE_CHECK_PROFILES.default

  const required = profile.required
    .map(id => WORLDVIEW_CHECK_MAP.get(id))
    .filter((x): x is WorldviewCheckItem => x != null)

  const extra = profile.extra
    .map(id => WORLDVIEW_CHECK_MAP.get(id))
    .filter((x): x is WorldviewCheckItem => x != null)

  const seen = new Set<string>()
  const all: WorldviewCheckItem[] = []
  for (const item of [...required, ...extra]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    all.push(item)
  }

  return {
    genreId: resolvedGenreId,
    profile,
    required,
    extra,
    all
  }
}

