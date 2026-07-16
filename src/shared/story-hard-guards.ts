export const STORY_META_RESIDUE_RULES: Array<[RegExp, string]> = [
  [/^\s*文风[：:]/m, '正文残留文风标签'],
  [/（?承接上一(?:章|拍|节).*?）?/m, '正文残留承接提示'],
  [/【(?:写作要求|创作目标|节拍大纲|戏剧契约|情绪执行卡|全篇故事合同)】/m, '正文残留生成提示或元数据'],
  [/^(?:下面|以下)(?:开始|继续)(?:写|生成|续写)/m, '正文残留生成说明']
]

export function detectStoryMetaResidues(text: string): string[] {
  return STORY_META_RESIDUE_RULES.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)
}

interface ContinuityShape {
  time_anchor?: string
  elapsed_from_previous?: string
  start_location?: string
  end_location?: string
  entry_facts?: string[]
  exit_facts?: string[]
  opponent_action?: string
  opponent_reasoning?: string
  damage_to_protagonist?: string
  protagonist_adjustment?: string
}

interface StoryBeatGuardInput {
  continuity_contract?: ContinuityShape | null
  tension_plan?: { payoff_type: string } | null
}

const HANDOFF_EVIDENCE_TERMS = ['存根', '证据', 'U盘', '信封', '录音', '手机', '资料', '成绩单', '项链', '钥匙', '档案']

function evidenceState(text: string, term: string): 'left' | 'held' | null {
  if (!text.includes(term)) return null
  if (/未(?:捡|拿|收|转移)|仍(?:留|在)|留在|散落|地面|原处/.test(text)) return 'left'
  if (/口袋|手里|持有|拿到|捡起|收好|藏进|随身|交给/.test(text)) return 'held'
  return null
}

function adjacentContractIssues(
  current: ContinuityShape,
  next: ContinuityShape,
  index: number
): string[] {
  const issues: string[] = []
  const currentExit = (current.exit_facts ?? []).join('；')
  const nextEntry = (next.entry_facts ?? []).join('；')
  for (const term of HANDOFF_EVIDENCE_TERMS) {
    const before = evidenceState(currentExit, term)
    const after = evidenceState(nextEntry, term)
    if (before && after && before !== after) {
      issues.push(`第${index + 1}拍离场与第${index + 2}拍入场的${term}状态矛盾：上一拍为${before === 'left' ? '留在原处' : '人物持有'}，下一拍变为${after === 'left' ? '留在原处' : '人物持有'}`)
    }
  }
  const immediate = /立即|紧接|同一(?:时刻|现场)|没有间隔|零间隔/.test(next.elapsed_from_previous ?? '')
  const end = current.end_location?.replace(/[，。；、\s]/g, '') ?? ''
  const start = next.start_location?.replace(/[，。；、\s]/g, '') ?? ''
  if (immediate && end && start && !end.includes(start) && !start.includes(end)) {
    issues.push(`第${index + 1}拍结束地点“${current.end_location}”与第${index + 2}拍即时开始地点“${next.start_location}”不一致`)
  }
  return issues
}

export function validateStoryContinuityContracts(chapters: StoryBeatGuardInput[]): string[] {
  const issues: string[] = []
  chapters.forEach((chapter, index) => {
    const contract = chapter.continuity_contract
    if (!contract) {
      issues.push(`第${index + 1}拍缺少 continuity_contract`)
      return
    }
    if (!contract.time_anchor) issues.push(`第${index + 1}拍缺少 time_anchor`)
    if (!contract.start_location || !contract.end_location) issues.push(`第${index + 1}拍缺少起止地点`)
    if (!contract.entry_facts?.length || !contract.exit_facts?.length) issues.push(`第${index + 1}拍缺少入场/离场事实`)
    if (index > 0 && !contract.elapsed_from_previous) issues.push(`第${index + 1}拍缺少 elapsed_from_previous`)
    const isFinal = index === chapters.length - 1
    if (index > 0 && !isFinal) {
      if (!contract.opponent_action || !contract.opponent_reasoning) issues.push(`第${index + 1}拍缺少对手有效反制及其推理依据`)
      if (!contract.damage_to_protagonist || !contract.protagonist_adjustment) issues.push(`第${index + 1}拍缺少反制造成的损害或主角计划调整`)
    }
    if (isFinal && chapter.tension_plan?.payoff_type !== 'aftertaste' && chapter.tension_plan?.payoff_type !== 'major') {
      issues.push('最终拍必须是 major 或 aftertaste 兑现')
    }
    const next = chapters[index + 1]?.continuity_contract
    if (next) issues.push(...adjacentContractIssues(contract, next, index))
  })
  return issues
}
