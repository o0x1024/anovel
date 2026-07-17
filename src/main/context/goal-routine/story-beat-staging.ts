import type { ParsedChapter } from '../parse-chapters'

export const BEAT_SKELETON_MAX_TOKENS = 4200
export const BEAT_CONTRACT_MAX_TOKENS = 3600
export const BEAT_STAGE_MAX_ATTEMPTS = 2

export type BeatGateRecovery = 'retry_beats' | 'rebuild_contract' | 'rebuild_engine' | 'simplify'
export type BeatGateIssueLayer = 'skeleton' | 'contract'

/** 节拍失败先在本层收敛，再逐级扩大修复半径；禁止每次都销毁已通过的上游发动机。 */
export function beatGateRecoveryForFailureCount(count: number): BeatGateRecovery {
  const position = ((Math.max(1, count) - 1) % 4) + 1
  if (position === 1) return 'retry_beats'
  if (position === 2) return 'rebuild_contract'
  if (position === 3) return 'rebuild_engine'
  return 'simplify'
}

/**
 * 门禁若能明确归因到某几拍，只重做那些拍的合同。无法定位的全局因果问题才重做整组。
 */
export function beatGateRepairIndexes(issues: string[], beatCount: number): number[] {
  const indexes = new Set<number>()
  for (const issue of issues) {
    for (const match of issue.matchAll(/第\s*(\d+)\s*[-—至到~～]\s*(\d+)\s*拍/g)) {
      const start = Number(match[1])
      const end = Number(match[2])
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue
      for (let beat = Math.min(start, end); beat <= Math.max(start, end); beat++) {
        if (beat >= 1 && beat <= beatCount) indexes.add(beat - 1)
      }
    }
    for (const match of issue.matchAll(/第\s*((?:\d+\s*[、,，]\s*)+\d+)\s*拍/g)) {
      for (const raw of match[1].split(/[、,，]/)) {
        const beat = Number(raw.trim())
        if (Number.isInteger(beat) && beat >= 1 && beat <= beatCount) indexes.add(beat - 1)
      }
    }
    for (const match of issue.matchAll(/第\s*(\d+)\s*拍/g)) {
      const index = Number(match[1]) - 1
      if (Number.isInteger(index) && index >= 0 && index < beatCount) indexes.add(index)
    }
  }
  return [...indexes].sort((left, right) => left - right)
}

export function beatGateIssueLayer(issue: string): BeatGateIssueLayer {
  return /plot_outline|事件骨架|触发事件|核心事件|铺垫|伏笔|天降|巧合|悬浮|不合理|逻辑严重|突然引入|突然空降/.test(issue)
    ? 'skeleton'
    : 'contract'
}

export function beatGateIssuesForLayer(issues: string[], layer: BeatGateIssueLayer): string[] {
  return issues.filter(issue => beatGateIssueLayer(issue) === layer)
}

export function beatGateNeedsSkeletonModelRepair(issue: string): boolean {
  if (beatGateIssueLayer(issue) !== 'skeleton') return false
  // 最终拍钩子是格式性硬伤，由确定性清理器处理，不值得再调用模型重写事件。
  return !(/plot_outline/.test(issue) && /最终拍|续集|钩子|闭环/.test(issue))
}

/** 连续性不是单拍属性；修复人物知识、时间、地点或证据时一并携带相邻拍。 */
export function beatGateContractRepairIndexes(issues: string[], beatCount: number): number[] {
  const indexes = new Set(beatGateRepairIndexes(issues, beatCount))
  for (const issue of issues) {
    if (!/continuity_contract|连续性|时间线|时间锚点|地点|人物认知|知识状态|entry_facts|knowledge_changes|info_gap|证据/.test(issue)) continue
    for (const index of beatGateRepairIndexes([issue], beatCount)) {
      if (index > 0) indexes.add(index - 1)
      if (index + 1 < beatCount) indexes.add(index + 1)
    }
  }
  return [...indexes].sort((left, right) => left - right)
}

export function sanitizeBeatSkeleton(chapter: ParsedChapter, isFinalBeat: boolean): ParsedChapter {
  if (!isFinalBeat) return chapter
  const outline = (chapter.outline ?? '')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:【?章末钩子】?|【?下一拍钩子】?|next_hook)\s*[:：]?/i.test(line))
    .join('\n')
    .trim()
  return {
    ...chapter,
    outline,
    next_hook: '',
    dramatic_contract: chapter.dramatic_contract
      ? { ...chapter.dramatic_contract, next_question: '' }
      : chapter.dramatic_contract
  }
}

export function beatGateResolvedTargetCount(previousIssues: string[], nextIssues: string[], beatCount: number): number {
  const previous = new Set(beatGateIssueSignature(previousIssues, beatCount).split('|').filter(Boolean))
  const next = new Set(beatGateIssueSignature(nextIssues, beatCount).split('|').filter(Boolean))
  return [...previous].filter(key => !next.has(key)).length
}

export function beatGateIssuesForIndex(issues: string[], index: number, beatCount: number): string[] {
  return issues.filter(issue => {
    const indexes = beatGateRepairIndexes([issue], beatCount)
    return indexes.length === 0 || indexes.includes(index)
  })
}

export function beatGateIssueSignature(issues: string[], beatCount: number): string {
  const families = issues.flatMap(issue => {
    const indexes = beatGateRepairIndexes([issue], beatCount)
    const prefix = indexes.length > 0 ? indexes.map(index => index + 1).join(',') : 'all'
    const types = [
      /emotion_contract|情绪/.test(issue) ? 'emotion' : '',
      /continuity_contract|连续性|时间|地点|知识|证据|entry_facts|exit_facts|knowledge_changes/.test(issue) ? 'continuity' : '',
      /tension_plan|张力|压力/.test(issue) ? 'tension' : '',
      /dramatic_contract|info_gap|目标|阻力|代价|转折|不可逆/.test(issue) ? 'dramatic' : '',
      /next_hook|next_question|续集|钩子|最终拍|闭环/.test(issue) ? 'ending' : ''
    ].filter(Boolean)
    return (types.length > 0 ? types : ['semantic']).map(type => `${prefix}:${type}`)
  })
  return [...new Set(families)].sort().join('|')
}

export function storyBeatStageKey(prompt: string, beatCount: number): string {
  let hash = 2166136261
  for (let index = 0; index < prompt.length; index++) {
    hash ^= prompt.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${beatCount}:${prompt.length}:${(hash >>> 0).toString(16)}`
}

export function compactBeatSkeletons(chapters: ParsedChapter[]): Array<Record<string, unknown>> {
  return chapters.map((chapter, index) => ({
    index: index + 1,
    title: chapter.title,
    plot_outline: chapter.outline,
    beat_role: chapter.beat_role,
    foreshadow_target: chapter.foreshadow_target,
    next_hook: chapter.next_hook,
    characters: chapter.characters
  }))
}

export function mergeStagedBeat(
  skeleton: ParsedChapter,
  enriched: ParsedChapter,
  options: { current?: ParsedChapter; issues?: string[]; isFinalBeat?: boolean } = {}
): ParsedChapter {
  const current = options.current
  const issueText = (options.issues ?? []).join('\n')
  const replaceAll = !current || !issueText
  const replaceDramatic = replaceAll || /dramatic_contract|info_gap|目标|阻力|代价|转折|不可逆|next_question|最终拍|闭环|续集|钩子/.test(issueText)
  const replaceContinuity = replaceAll || /continuity_contract|连续性|时间|地点|知识|证据|entry_facts|exit_facts|knowledge_changes/.test(issueText)
  const replaceTension = replaceAll || /tension_plan|张力|压力/.test(issueText)
  const replaceEmotion = replaceAll || /emotion_contract|情绪|certainty|action_impulse/.test(issueText)
  const merged: ParsedChapter = {
    ...skeleton,
    // 事件链和标题由全篇骨架锁定，单拍补全不得悄悄改写全篇结构。
    title: skeleton.title,
    outline: skeleton.outline,
    beat_role: current?.beat_role ?? enriched.beat_role ?? skeleton.beat_role,
    foreshadow_target: current?.foreshadow_target ?? enriched.foreshadow_target ?? skeleton.foreshadow_target,
    next_hook: current?.next_hook ?? enriched.next_hook ?? skeleton.next_hook,
    characters: current?.characters ?? enriched.characters ?? skeleton.characters,
    dramatic_contract: replaceDramatic ? (enriched.dramatic_contract ?? current?.dramatic_contract) : current?.dramatic_contract,
    continuity_contract: replaceContinuity ? (enriched.continuity_contract ?? current?.continuity_contract) : current?.continuity_contract,
    tension_plan: replaceTension ? (enriched.tension_plan ?? current?.tension_plan) : current?.tension_plan,
    emotion_contract: replaceEmotion ? (enriched.emotion_contract ?? current?.emotion_contract) : current?.emotion_contract
  }
  if (options.isFinalBeat) {
    merged.next_hook = ''
    if (merged.dramatic_contract) merged.dramatic_contract = { ...merged.dramatic_contract, next_question: '' }
  } else if (replaceDramatic && enriched.next_hook != null) {
    merged.next_hook = enriched.next_hook
  }
  return merged
}

export function mergeStoryBlueprintDiagnosis(
  existingJson: string | null | undefined,
  patch: Pick<ParsedChapter, 'dramatic_contract' | 'continuity_contract' | 'tension_plan' | 'emotion_contract'>
): string | null {
  let existing: Record<string, unknown> = {}
  try {
    const parsed = existingJson?.trim() ? JSON.parse(existingJson) as unknown : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch {
    return existingJson ?? null
  }
  const merged = {
    dramatic_contract: patch.dramatic_contract ?? existing.dramatic_contract ?? null,
    continuity_contract: patch.continuity_contract ?? existing.continuity_contract ?? null,
    tension_plan: patch.tension_plan ?? existing.tension_plan ?? null,
    emotion_contract: patch.emotion_contract ?? existing.emotion_contract ?? null
  }
  return Object.values(merged).some(Boolean) ? JSON.stringify(merged) : existingJson ?? null
}

export function exactStageCountError(actual: number, expected: number, label: string): string | null {
  return actual === expected ? null : `${label}数量不符：期望 ${expected}，实际 ${actual}`
}
