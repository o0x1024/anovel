export type StoryGenreMode = 'suspense' | 'romance' | 'comedy' | 'realistic' | 'power'

export interface StoryGenrePolicy {
  mode: StoryGenreMode
  label: string
  engineRules: string[]
  beatRules: string[]
  proseRules: string[]
  evaluationRules: string[]
}

const POLICIES: Record<StoryGenreMode, StoryGenrePolicy> = {
  suspense: {
    mode: 'suspense',
    label: '悬疑/惊悚',
    engineRules: [
      '真相必须能由前文可见线索复盘，不得依赖终局临时宣布的新规则',
      '主角至少做出一次有依据但错误的判断，并因此付出具体代价',
      '核心谜面、误导方向、关键证据和真相回收必须形成闭环'
    ],
    beatRules: [
      '按“谜面建立→调查受阻→错误判断付代价→证据改写认知→真相与代价”组织全篇',
      '允许低烈度调查拍，但该拍必须获得线索、排除假设或扩大风险',
      '禁止在发现异常后立刻用内心独白解释完整答案；结尾问题必须来自新证据或迫近危险'
    ],
    proseRules: [
      '用可观察细节制造不安，少写“我意识到/原来/这说明”的解释性结论',
      '线索出现时只呈现角色当下能理解的部分，保留可推理空间'
    ],
    evaluationRules: ['重点判断线索公平性、误导合理性、信息释放节奏与真相可复盘性']
  },
  romance: {
    mode: 'romance',
    label: '言情/关系',
    engineRules: [
      '双方必须各有欲望、恐惧和不可轻易让步的边界',
      '核心阻碍必须来自价值选择或现实利益，不得只靠不沟通维持',
      '终局关系变化必须由双方行动换来'
    ],
    beatRules: [
      '按“吸引/排斥→关系试探→信任受损或加深→关键选择→关系兑现”组织全篇',
      '每拍改变关系阶段，不强求惊吓式反转或羞辱打脸'
    ],
    proseRules: ['用潜台词、行为反差和边界试探写情感，不用旁白直接宣布爱恨'],
    evaluationRules: ['重点判断关系阶段变化、吸引依据、阻碍合理性和双向选择']
  },
  comedy: {
    mode: 'comedy',
    label: '喜剧',
    engineRules: [
      '主角的认真目标与现实反馈必须形成稳定反差',
      '笑点应由人物性格和因果产生，不靠随机降智'
    ],
    beatRules: [
      '按“规则建立→误判累积→反应差升级→意外回收→更大后果”组织笑点',
      '每次升级必须改变处境，禁止重复同一个梗'
    ],
    proseRules: ['少解释笑点，让动作、停顿、误会和人物反应自己完成包袱'],
    evaluationRules: ['重点判断铺垫—误导—回收、反应差和笑点边际递增']
  },
  realistic: {
    mode: 'realistic',
    label: '现实/成长',
    engineRules: [
      '矛盾必须扎根于具体关系、利益和生活处境',
      '主角成长必须体现为一次有损失的选择，而不是身份或能力突然翻盘'
    ],
    beatRules: [
      '按“日常裂缝→关系施压→两难选择→承担损失→有限但可信的改变”组织全篇',
      '允许克制和留白，但每拍必须改变关系、认知或现实条件'
    ],
    proseRules: ['用生活细节和不完整对话呈现情绪，禁止持续高声量身体反应'],
    evaluationRules: ['重点判断人物选择、生活可信度、关系变化和结局余味']
  },
  power: {
    mode: 'power',
    label: '爽感/脑洞',
    engineRules: [
      '能力必须有边界、代价或暴露风险，不能自动解决核心矛盾',
      '对手必须基于自身信息做出合理反制，禁止主动自曝全部罪证',
      '终局胜利必须来自主角筹备、选择和承担风险'
    ],
    beatRules: [
      '按“压迫/欠债→试探能力与代价→对手反制→主动布局→付出代价后兑现”组织全篇',
      '小兑现与新欠债交替，不得每拍都让对手震惊、下跪或群众倒戈'
    ],
    proseRules: ['爽点前必须写清阻力和失败可能，兑现后保留损失或新局面'],
    evaluationRules: ['重点判断压迫—筹备—反击因果、能力代价、对手智力和爽点兑现']
  }
}

export function resolveStoryGenrePolicy(text: string): StoryGenrePolicy {
  if (/悬疑|推理|刑侦|惊悚|谜案|怪谈|诡秘|灵异/.test(text)) return POLICIES.suspense
  if (/喜剧|搞笑|沙雕|幽默/.test(text)) return POLICIES.comedy
  if (/言情|爱情|婚恋|甜宠|虐恋|纯爱|暗恋|追妻|追夫/.test(text)) return POLICIES.romance
  if (/现实|家庭|职场|社会|治愈|成长|生活|年代/.test(text)) return POLICIES.realistic
  return POLICIES.power
}

export function formatGenrePolicy(policy: StoryGenrePolicy, section: keyof Pick<StoryGenrePolicy, 'engineRules' | 'beatRules' | 'proseRules' | 'evaluationRules'>): string {
  return [`【${policy.label}题材专用规则】`, ...policy[section].map(rule => `- ${rule}`)].join('\n')
}

export function tensionCurveForBeat(index: number, total: number): { phase: string; min: number; max: number } {
  const ratio = total <= 1 ? 1 : index / total
  if (ratio <= 0.2) return { phase: '承诺与失衡', min: 6, max: 8 }
  if (ratio <= 0.45) return { phase: '蓄力与受阻', min: 4, max: 7 }
  if (ratio <= 0.7) return { phase: '代价与认知改写', min: 6, max: 9 }
  if (ratio < 1) return { phase: '主动选择与逼近高潮', min: 7, max: 9 }
  return { phase: '高潮兑现与余味', min: 8, max: 10 }
}

export function validateTensionPlans(
  chapters: Array<{ tension_plan?: { level: number; payoff_type: string } | null }>
): string[] {
  const issues: string[] = []
  chapters.forEach((chapter, index) => {
    const plan = chapter.tension_plan
    const expected = tensionCurveForBeat(index + 1, chapters.length)
    if (!plan) {
      issues.push(`第${index + 1}拍缺少 tension_plan`)
      return
    }
    if (plan.level < expected.min || plan.level > expected.max) {
      issues.push(`第${index + 1}拍张力 ${plan.level} 不在 ${expected.min}-${expected.max}`)
    }
    if (index > 0 && plan.payoff_type === 'major' && chapters[index - 1]?.tension_plan?.payoff_type === 'major') {
      issues.push(`第${index}拍与第${index + 1}拍连续重大兑现，缺少蓄力`)
    }
  })
  return issues
}
