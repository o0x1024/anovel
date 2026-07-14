export type GoldenOpeningWorkType = 'novel' | 'story'

export interface HookBodyOverlapAssessment {
  applicable: boolean
  passed: boolean
  score: number
  issue: string
}

function normalizeForOverlap(text: string): string {
  return text
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

function grams(text: string, size = 4): Set<string> {
  const result = new Set<string>()
  for (let i = 0; i <= text.length - size; i++) result.add(text.slice(i, i + size))
  return result
}

/** 确定性检查导语与首拍前段是否在复述同一段内容。 */
export function assessHookBodyOverlap(hook: string, body: string): HookBodyOverlapAssessment {
  const left = normalizeForOverlap(hook)
  const right = normalizeForOverlap(body.slice(0, Math.max(900, hook.length * 4)))
  if (left.length < 40 || right.length < 40) {
    return { applicable: false, passed: true, score: 0, issue: '' }
  }
  const hookGrams = grams(left)
  const bodyGrams = grams(right)
  let shared = 0
  for (const gram of hookGrams) if (bodyGrams.has(gram)) shared++
  const score = hookGrams.size > 0 ? shared / hookGrams.size : 0
  const passed = score < 0.34
  return {
    applicable: true,
    passed,
    score,
    issue: passed
      ? ''
      : `导语与首拍前段四字片段重合率 ${Math.round(score * 100)}%，疑似重复导语场景或台词；首拍必须从导语结束后的新动作、新信息或新后果继续推进。`
  }
}

export function goldenOpeningLabel(workType: GoldenOpeningWorkType, ordinal: number): string | null {
  if (workType === 'story') return ordinal === 1 ? '黄金开头·第一节拍' : null
  if (ordinal === 1) return '黄金前三章·第一章立钩子'
  if (ordinal === 2) return '黄金前三章·第二章扩承诺'
  if (ordinal === 3) return '黄金前三章·第三章首兑现'
  return null
}

export function goldenOpeningSystemExtra(workType: GoldenOpeningWorkType, ordinal: number): string {
  if (workType === 'story') {
    if (ordinal !== 1) return ''
    return [
      '【首拍黄金开局 - 最高优先级硬约束】',
      '- 前300字必须建立正在发生的具体失衡，并给出读者愿意在乎人物或结果的可观察依据。',
      '- 第一句必须是冲突本身或直接后果；禁止人物介绍、背景说明和氛围铺垫。',
      '- 前3句须让读者知道谁正在失去什么或哪里明显不对劲。',
      '- 若提供导语，正文不得复述导语场景或台词，必须从导语之后的新动作、新信息或新后果继续推进。'
    ].join('\n')
  }
  if (ordinal < 1 || ordinal > 3) return ''
  const contracts: Record<number, string[]> = {
    1: [
      '【黄金前三章·第一章 - 立钩子】',
      '- 前100字让核心人物进入正在发生的异常、危机、欲望或冲突，不得以世界观说明开篇。',
      '- 本章必须立住主角的处境、当下目标和核心差异，并明确失败会失去什么。',
      '- 章末把主角推入不可回避的新局面，形成第二章必须处理的具体问题。'
    ],
    2: [
      '【黄金前三章·第二章 - 扩大承诺】',
      '- 直接承接第一章后果，禁止重新开场或重复介绍设定。',
      '- 扩大阻力、信息差或代价，让读者看见本书核心玩法能够持续升级。',
      '- 至少新增一项关系、线索或规则变化，并把第三章的首次兑现推到眼前。'
    ],
    3: [
      '【黄金前三章·第三章 - 首次兑现】',
      '- 必须兑现前两章建立的至少一项核心承诺，形成可感知的小高潮、反转、胜利或代价性突破。',
      '- 兑现必须由主角选择与前文因果触发，禁止天降救场。',
      '- 兑现后产生更大的敌人、债务、秘密或目标，让读者明确为什么要继续追读。'
    ]
  }
  return contracts[ordinal].join('\n')
}

export function goldenOpeningUserSection(input: {
  workType: GoldenOpeningWorkType
  ordinal: number
  hook?: string
  openingDesign?: string
}): string {
  const { workType, ordinal, hook = '', openingDesign = '' } = input
  const parts: string[] = []
  if (workType === 'story' && ordinal === 1 && openingDesign.trim()) {
    parts.push(`【黄金开局设计 - 必须执行】\n${openingDesign.trim()}`)
  }
  if (ordinal === 1 && hook.trim()) {
    parts.push(workType === 'story'
      ? `【发布导语 - 正文不得复述】\n${hook.trim()}\n首拍须承接导语之后的新动作、新信息或新后果。`
      : `【作品导语承诺】\n${hook.trim()}\n第一章须兑现其冲突方向与核心卖点，但不得机械照抄导语。`)
  }
  return parts.join('\n\n')
}

export function goldenOutlineContract(workType: GoldenOpeningWorkType, start: number, end: number): string {
  if (workType === 'story') {
    return start === 1
      ? '【第一节拍黄金开局】第一项必须直切具体冲突；标题体现冲突场景；beat_role 只能为 A/B；前300字不得依赖背景铺垫；结尾必须产生不可逆变化和具体追问。'
      : ''
  }
  if (start > 3 || end < 1) return ''
  return [
    '【黄金前三章联合合同 - 第1至3章必须形成一个完整留存单元】',
    '- 第1章立钩子：前100字进入异常/危机/欲望，立住主角处境、目标、差异和失败代价，章末进入不可回避的新局面。',
    '- 第2章扩承诺：承接第一章后果，扩大阻力/信息差/代价，证明核心玩法可持续升级，并把首次兑现推到眼前。',
    '- 第3章首兑现：由主角选择和前文因果触发第一次明确小高潮/反转/突破，同时产生更大的敌人、债务、秘密或目标。',
    '- 三章禁止重复开场、重复解释设定、连续只欠债不兑现，或第三章以天降救场完成爽点。'
  ].join('\n')
}
