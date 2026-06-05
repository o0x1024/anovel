import { appPreferenceDAO, BUILTIN_STYLES_SEEDED_KEY } from './dao/app-preference-dao'
import { writingStyleDAO } from './dao/style-dao'
import { workDAO } from './dao/work-dao'
import { getBuiltinStepRulesJson } from './builtin-style-step-rules'

const BUILTIN_STYLES = [
  {
    name: '现代网文-爽文',
    description: '节奏明快、冲突密集、金句频出，适合玄幻/都市爽文',
    prompt_template: `【文风要求】
你是一位精通网络文学的作家，请用以下风格创作：
1. 句子短促有力，平均句长不超过25字
2. 对话占比不低于40%，角色对话需有辨识度
3. 每段末尾留悬念或钩子
4. 适当使用口语化表达和网络热词
5. 动作描写干脆利落，少用冗长形容词
6. 情绪渲染直接，忌含蓄委婉`,
    sample_text: ''
  },
  {
    name: '传统文学-细腻',
    description: '文笔细腻、心理描写丰富、节奏舒缓，适合文艺/情感类',
    prompt_template: `【文风要求】
你是一位注重文学性的作家，请用以下风格创作：
1. 注重心理描写和环境烘托，让情感通过细节自然流露
2. 句式多变，长短结合，允许适度使用长句营造氛围
3. 对话服务于角色塑造，每句话体现角色性格
4. 描写有画面感，善用比喻和通感
5. 节奏张弛有度，留白给读者想象空间
6. 避免网络用语和过于直白的表达`,
    sample_text: ''
  },
  {
    name: '悬疑推理-冷峻',
    description: '逻辑严密、信息密度高、伏笔铺垫多，适合悬疑/推理/谍战',
    prompt_template: `【文风要求】
你是一位悬疑推理作家，请用以下风格创作：
1. 叙述冷峻客观，保持叙事者的距离感
2. 信息密度高，每个细节都可能成为线索
3. 对话暗藏机锋，角色之间信息不对等
4. 善用逆向思维和意料之外的转折
5. 伏笔自然埋设，回收时不突兀
6. 保持逻辑自洽，因果关系清晰
7. 节奏控制：铺垫期缓慢蓄力，高潮期密集释放`,
    sample_text: ''
  },
  {
    name: '轻小说-活泼',
    description: '轻松幽默、角色鲜明、吐槽与卖萌并存，适合轻小说/日常向',
    prompt_template: `【文风要求】
你是一位轻小说作家，请用以下风格创作：
1. 叙述口吻轻松活泼，如同朋友聊天
2. 角色对话中加入吐槽、颜文字式的情感表达
3. 日常场景中加入有趣的细节和内心戏
4. 节奏轻快，章节短小精悍
5. 适当打破第四面墙，与读者互动
6. 笑点自然，不刻意搞笑`,
    sample_text: ''
  },
  {
    name: '历史正剧-厚重',
    description: '用词典雅、考据严谨、格局宏大，适合历史/架空史诗',
    prompt_template: `【文风要求】
你是一位历史小说作家，请用以下风格创作：
1. 语言典雅但不晦涩，兼顾古典韵味与现代可读性
2. 时代感明确，称谓、器物、礼仪需符合时代背景
3. 叙事格局宏大，兼顾庙堂与江湖
4. 人物行为受时代约束，避免现代价值观穿越
5. 对话符合人物身份和时代语境
6. 节奏沉稳，重要节点浓墨重彩
7. 在历史框架中寻找人性共通的戏剧性`,
    sample_text: ''
  },
  {
    name: '科幻硬核-冷感',
    description: '逻辑自洽、概念清晰、技术细节可信，适合硬科幻/赛博朋克',
    prompt_template: `【文风要求】
你是一位硬科幻作家，请用以下风格创作：
1. 技术设定有内在逻辑，新概念首次出现需简要解释
2. 叙述克制冷静，避免过度抒情
3. 用具体细节构建未来/异星世界的真实感
4. 对话简洁高效，体现专业背景差异
5. 因果关系清晰，科幻元素服务于主题而非炫技
6. 适当留白，让读者自行推演`,
    sample_text: ''
  },
  {
    name: '古风仙侠-飘逸',
    description: '辞藻清丽、意境悠远、仙凡有别，适合修仙/武侠',
    prompt_template: `【文风要求】
你是一位仙侠作家，请用以下风格创作：
1. 语言有古典韵味，但保持现代可读性
2. 写景写意，善用意象（月、剑、云、鹤等）
3. 打斗描写有节奏感，招式名称与动作呼应
4. 对话可文可白，高人语带机锋，凡人朴实
5. 境界、功法、宗门设定前后一致
6. 张弛有度，大战前蓄势，日常中见人性`,
    sample_text: ''
  },
  {
    name: '都市情感-细腻',
    description: '生活质感、情感真实、细节动人，适合都市言情/现实题材',
    prompt_template: `【文风要求】
你是一位都市情感作家，请用以下风格创作：
1. 场景有生活质感（咖啡、地铁、办公室、深夜便利店）
2. 情感通过小动作和沉默表达，忌直白说教
3. 对话贴近当代口语，但有个人特色
4. 内心独白真实，允许矛盾与不确定
5. 节奏贴近生活，高潮来自情感爆发而非动作
6. 配角有独立生活，不只是工具人`,
    sample_text: ''
  },
  {
    name: '幽默吐槽-网感',
    description: '梗密集、自嘲、节奏快，适合搞笑/吐槽向网文',
    prompt_template: `【文风要求】
你是一位幽默向网文作家，请用以下风格创作：
1. 叙述者可适度吐槽，打破常规叙事距离
2. 善用夸张、反讽、意外类比制造笑点
3. 对话 witty，角色互相拆台但不失性格
4. 节奏快，段落短，信息密度高
5. 笑点与情节推进结合，不为了搞笑而搞笑
6. 适当使用网络流行语，但不过度堆砌`,
    sample_text: ''
  },
  {
    name: '童话寓言-温暖',
    description: '语言简洁、寓意深远、适合全年龄，适合童话/寓言体',
    prompt_template: `【文风要求】
你是一位童话作家，请用以下风格创作：
1. 语言简洁优美，句子不宜过长
2. 角色鲜明，善恶有度但不脸谱化
3. 每个场景有画面感，适合朗读
4. 寓意自然融入故事，不说教
5. 节奏温和，危机可化解，留有希望
6. 重复与韵律可适度使用，增强记忆点`,
    sample_text: ''
  }
] as const

export const BUILTIN_STYLE_NAMES = BUILTIN_STYLES.map(s => s.name)

/** 老用户升级：若曾 seed 过（有预设名或已有作品），补写标记避免再次插入 */
function ensureBuiltinStylesSeedFlag(): boolean {
  if (appPreferenceDAO.getPreference(BUILTIN_STYLES_SEEDED_KEY) === '1') {
    return true
  }

  const hasPreset = BUILTIN_STYLE_NAMES.some(name => !!writingStyleDAO.getByName(name))
  const hasWorks = workDAO.list().length > 0
  if (hasPreset || hasWorks) {
    appPreferenceDAO.setPreference(BUILTIN_STYLES_SEEDED_KEY, '1')
    return true
  }

  return false
}

function patchBuiltinStepRules(): number {
  let patched = 0
  for (const name of BUILTIN_STYLE_NAMES) {
    const stepRulesJson = getBuiltinStepRulesJson(name)
    const existing = writingStyleDAO.getByName(name)
    if (existing && stepRulesJson && !existing.step_rules_json) {
      writingStyleDAO.update(existing.id, { step_rules_json: stepRulesJson })
      patched++
    }
  }
  return patched
}

/** 修正历史数据中 is_builtin 未正确写入的预设文风 */
function fixBuiltinFlags(): number {
  let fixed = 0
  for (const name of BUILTIN_STYLE_NAMES) {
    const existing = writingStyleDAO.getByName(name)
    if (existing && !existing.is_builtin) {
      writingStyleDAO.update(existing.id, { is_builtin: 1 })
      fixed++
    }
  }
  return fixed
}

/**
 * 内置文风预设 - 仅在首次安装时写入
 * 升级后通过 app_preferences 标记避免重复插入；仍会为现存预设补全 step_rules
 */
export function seedBuiltinStyles(): void {
  const alreadySeeded = ensureBuiltinStylesSeedFlag()

  const flagsFixed = fixBuiltinFlags()
  if (flagsFixed > 0) {
    console.log(`[DB] Fixed is_builtin for ${flagsFixed} built-in writing styles`)
  }

  if (alreadySeeded) {
    const patched = patchBuiltinStepRules()
    if (patched > 0) {
      console.log(`[DB] Patched step_rules_json for ${patched} built-in styles`)
    }
    return
  }

  let inserted = 0
  for (const style of BUILTIN_STYLES) {
    const stepRulesJson = getBuiltinStepRulesJson(style.name)
    writingStyleDAO.create({
      ...style,
      is_builtin: 1,
      step_rules_json: stepRulesJson
    })
    inserted++
  }

  appPreferenceDAO.setPreference(BUILTIN_STYLES_SEEDED_KEY, '1')

  if (inserted > 0) {
    console.log(`[DB] Seeded ${inserted} built-in writing styles (first install)`)
  }
}
