import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import { withGoalLoopModelOptions } from './story-goal-model'

export interface TitleHookOption {
  title: string
  hook: string
}

export interface VariantComparison {
  preferCandidate: boolean
  reason: string
  candidateWins: number
  baselineWins: number
}

function parseObject(content: string): Record<string, unknown> | null {
  const text = extractJsonText(content.trim()) ?? content.match(/(\{[\s\S]*\})/)?.[1]
  if (!text) return null
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function deterministicOrder<T extends TitleHookOption>(workId: number, candidates: T[]): T[] {
  const hash = (text: string): number => {
    let value = workId | 0
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
    return value >>> 0
  }
  return [...candidates].sort((a, b) => hash(`${a.title}\n${a.hook}`) - hash(`${b.title}\n${b.hook}`))
}

async function compareTitleHookPair<T extends TitleHookOption>(
  workId: number,
  goal: string,
  left: T,
  right: T,
  signal?: AbortSignal
): Promise<T> {
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_title_hook_pairwise',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 1000,
      systemPrompt: [
        '你是独立短故事包装终审。对同一故事的两个书名+导语做盲化成对比较。',
        '必须分别按两种展示顺序评分，降低位置偏差；不要因为更长、更夸张或堆热词而偏爱某项。',
        '评估：目标受众匹配、前三句冲突、具体场景、信息差、正文承诺、读完后的具体追问、标题与导语一致。',
        '只输出 JSON：{"first":{"a":0,"b":0},"swapped":{"a":0,"b":0},"reason":"..."}。分数 0-100。'
      ].join('\n'),
      prompt: [
        `【创作目标】\n${goal.trim() || '高完读率短故事'}`,
        `【顺序一·A】\n书名：${left.title}\n导语：${left.hook}`,
        `【顺序一·B】\n书名：${right.title}\n导语：${right.hook}`,
        `【顺序二·A】\n书名：${right.title}\n导语：${right.hook}`,
        `【顺序二·B】\n书名：${left.title}\n导语：${left.hook}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) return left
  const parsed = parseObject(res.content)
  const first = parsed?.first as Record<string, unknown> | undefined
  const swapped = parsed?.swapped as Record<string, unknown> | undefined
  const score = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0
  const leftScore = score(first?.a) + score(swapped?.b)
  const rightScore = score(first?.b) + score(swapped?.a)
  return rightScore > leftScore ? right : left
}

/** 单淘汰盲评：候选先做确定性打乱，每一轮均交换位置复评。 */
export async function selectPreferredTitleHook<T extends TitleHookOption>(
  workId: number,
  goal: string,
  candidates: T[],
  signal?: AbortSignal
): Promise<T> {
  const ordered = deterministicOrder(workId, candidates)
  if (ordered.length === 0) throw new Error('没有可评审的书名导语候选')
  let winner = ordered[0]
  for (let i = 1; i < ordered.length; i++) {
    if (signal?.aborted) throw new Error('已取消')
    winner = await compareTitleHookPair(workId, goal, winner, ordered[i], signal)
  }
  return winner
}

async function judgeVariantOrder(
  workId: number,
  goal: string,
  outline: string,
  a: string,
  b: string,
  signal?: AbortSignal
): Promise<'a' | 'b' | 'tie'> {
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_repair_pairwise',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 900,
      systemPrompt: [
        '你是独立短故事改稿验收员。盲评两个版本，只判断哪个更适合作为最终正文。',
        '优先级：不违反大纲/设定与连续性 > 读者是否具体在乎人物并形成希望/恐惧 > 戏剧因果和局面变化 > 人物声音与潜台词 > 阅读自然度 > 局部华丽。',
        '情绪不按情绪词数量判断：必须由欲望、阻力、选择、代价和不可逆后果在正文中产生，并留下可感知余波。',
        '更长不等于更好；若新版修好一项却损坏已通过项，应判旧版胜。',
        '只输出 JSON：{"winner":"a|b|tie","reason":"..."}'
      ].join('\n'),
      prompt: [
        `【创作目标】\n${goal.trim() || '高完读率短故事'}`,
        `【本拍蓝图】\n${outline}`,
        `【版本 A】\n${a}`,
        `【版本 B】\n${b}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) return 'tie'
  const parsed = parseObject(res.content)
  const winner = String(parsed?.winner ?? '').toLowerCase()
  return winner === 'a' || winner === 'b' ? winner : 'tie'
}

/**
 * 前后版本交换位置各评一次。只有候选至少胜一次且基线零胜，才允许覆盖。
 * 评审失败、分歧或平局时保留原文。
 */
export async function compareRepairCandidate(
  workId: number,
  goal: string,
  outline: string,
  baseline: string,
  candidate: string,
  signal?: AbortSignal
): Promise<VariantComparison> {
  const first = await judgeVariantOrder(workId, goal, outline, baseline, candidate, signal)
  const second = await judgeVariantOrder(workId, goal, outline, candidate, baseline, signal)
  const baselineWins = Number(first === 'a') + Number(second === 'b')
  const candidateWins = Number(first === 'b') + Number(second === 'a')
  return {
    preferCandidate: candidateWins > 0 && baselineWins === 0,
    reason: candidateWins > baselineWins
      ? '候选在交换位置的盲评中胜出'
      : baselineWins > candidateWins
        ? '原文在交换位置的盲评中胜出'
        : '交换位置盲评未形成稳定优势',
    candidateWins,
    baselineWins
  }
}
