import { modelService } from '../../model'
import { volumeChapterDAO } from '../../db'
import { extractJsonText } from '../parse-json-extract'
import { withGoalLoopModelOptions } from './story-goal-model'

interface VolumeAssessment {
  volume: string
  structureScore: number
  escalationScore: number
  payoffScore: number
  continuityScore: number
  repetitionScore: number
  issues: string[]
  weakChapters: string[]
  summary: string
}

export interface NovelWholeAssessment {
  goalMatchScore: number
  goalMatchReason: string
  overallStoryScore: number
  overallStoryReason: string
  previewHookScore: number
  previewHookReason: string
  proseReadScore: number
  proseReadReason: string
  weakChapterTitles: string[]
  issues: string[]
}

function clampScore(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map(item => item.trim()).filter(Boolean) : []
}

function parseObject(content: string, label: string): Record<string, unknown> {
  const json = extractJsonText(content.trim()) ?? content.trim()
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('根节点必须是对象')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`${label}解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function chapterEvidence(chapter: ReturnType<typeof volumeChapterDAO.listChaptersByWork>[number]): string {
  const content = chapter.content?.trim() ?? ''
  const excerpt = content.length <= 1000
    ? content
    : `${content.slice(0, 500)}\n……\n${content.slice(-500)}`
  return [
    `## ${chapter.title}`,
    `大纲：${chapter.outline ?? ''}`,
    chapter.outline_diagnosis ? `结构合同：${chapter.outline_diagnosis}` : '',
    `正文抽样：${excerpt}`
  ].filter(Boolean).join('\n')
}

function deterministicRhythmIssues(chapters: ReturnType<typeof volumeChapterDAO.listChaptersByWork>): string[] {
  const issues: string[] = []
  let lowTensionStreak = 0
  let debtStreak = 0
  for (const chapter of chapters) {
    try {
      const parsed = JSON.parse(chapter.outline_diagnosis ?? '{}') as {
        tension_plan?: { level?: number; payoff_type?: string }
      }
      const level = Number(parsed.tension_plan?.level)
      lowTensionStreak = Number.isFinite(level) && level <= 4 ? lowTensionStreak + 1 : 0
      debtStreak = parsed.tension_plan?.payoff_type === 'debt' ? debtStreak + 1 : 0
      if (lowTensionStreak === 4) issues.push(`${chapter.title} 前连续4章张力不高于4`)
      if (debtStreak === 4) issues.push(`${chapter.title} 前连续4章只有蓄力欠账、没有阶段兑现`)
    } catch {
      issues.push(`${chapter.title} 的结构合同损坏`)
    }
  }
  return issues
}

async function assessVolume(
  workId: number,
  volumeName: string,
  chapters: ReturnType<typeof volumeChapterDAO.listChaptersByWork>,
  signal?: AbortSignal
): Promise<VolumeAssessment> {
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_novel_volume_evaluation',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      maxTokens: 1800,
      systemPrompt: [
        '你是长篇网文分卷终审编辑。根据章节合同、大纲和正文首尾抽样，检查本卷是否形成因果闭环、压力升级、阶段兑现和进入下一卷的新债务。',
        '同时识别重复任务结构、反派送人头、无代价获胜、连续水章、关系线停滞和伏笔久拖不决。',
        '只输出 JSON：{"structureScore":0,"escalationScore":0,"payoffScore":0,"continuityScore":0,"repetitionScore":0,"issues":[],"weakChapters":[],"summary":""}'
      ].join('\n'),
      prompt: `【分卷】${volumeName}\n\n${chapters.map(chapterEvidence).join('\n\n').slice(0, 50000)}`
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`${volumeName}终审失败：${response.error || '模型未返回内容'}`)
  }
  const parsed = parseObject(response.content, `${volumeName}终审`)
  return {
    volume: volumeName,
    structureScore: clampScore(parsed.structureScore),
    escalationScore: clampScore(parsed.escalationScore),
    payoffScore: clampScore(parsed.payoffScore),
    continuityScore: clampScore(parsed.continuityScore),
    repetitionScore: clampScore(parsed.repetitionScore),
    issues: stringArray(parsed.issues),
    weakChapters: stringArray(parsed.weakChapters),
    summary: String(parsed.summary ?? '').trim()
  }
}

export async function assessWholeNovel(
  workId: number,
  goalDescription: string,
  signal?: AbortSignal
): Promise<NovelWholeAssessment> {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  if (chapters.length === 0 || chapters.some(chapter => !chapter.content?.trim())) {
    throw new Error('小说正文尚未完整，不能执行整书终审')
  }

  const volumeNames = [...new Set(chapters.map(chapter => chapter.volume_name))]
  const volumeAssessments: VolumeAssessment[] = []
  for (const volumeName of volumeNames) {
    if (signal?.aborted) throw new Error('已取消')
    volumeAssessments.push(await assessVolume(
      workId,
      volumeName,
      chapters.filter(chapter => chapter.volume_name === volumeName),
      signal
    ))
  }

  const rhythmIssues = deterministicRhythmIssues(chapters)
  const sampleIndexes = new Set([
    0, 1,
    Math.floor(chapters.length * 0.25),
    Math.floor(chapters.length * 0.5),
    Math.floor(chapters.length * 0.75),
    chapters.length - 2,
    chapters.length - 1
  ].filter(index => index >= 0 && index < chapters.length))
  const proseSamples = [...sampleIndexes].sort((a, b) => a - b).map(index => chapterEvidence(chapters[index]))
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_novel_whole_evaluation',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      maxTokens: 2200,
      systemPrompt: [
        '你是长篇小说整书终审。综合各卷报告与开头/四分之一/中点/四分之三/结局盲读样本评分。',
        '重点判断：用户目标是否贯穿、主线是否升级、高潮是否由前文因果触发、结局是否兑现、正文是否有追读感和人味。',
        '只输出 JSON：{"goalMatchScore":0,"goalMatchReason":"","overallStoryScore":0,"overallStoryReason":"","previewHookScore":0,"previewHookReason":"","proseReadScore":0,"proseReadReason":"","weakChapterTitles":[],"issues":[]}'
      ].join('\n'),
      prompt: [
        `【用户创作目标】\n${goalDescription.trim() || '无额外目标，以作品既定设定为准'}`,
        `【分卷终审】\n${JSON.stringify(volumeAssessments, null, 2)}`,
        rhythmIssues.length ? `【确定性节奏问题】\n${rhythmIssues.join('\n')}` : '',
        `【跨阶段正文盲读样本】\n${proseSamples.join('\n\n').slice(0, 30000)}`
      ].filter(Boolean).join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`小说整书终审失败：${response.error || '模型未返回内容'}`)
  }
  const parsed = parseObject(response.content, '小说整书终审')
  return {
    goalMatchScore: clampScore(parsed.goalMatchScore),
    goalMatchReason: String(parsed.goalMatchReason ?? '').trim(),
    overallStoryScore: clampScore(parsed.overallStoryScore),
    overallStoryReason: String(parsed.overallStoryReason ?? '').trim(),
    previewHookScore: clampScore(parsed.previewHookScore),
    previewHookReason: String(parsed.previewHookReason ?? '').trim(),
    proseReadScore: clampScore(parsed.proseReadScore),
    proseReadReason: String(parsed.proseReadReason ?? '').trim(),
    weakChapterTitles: stringArray(parsed.weakChapterTitles),
    issues: [...new Set([...rhythmIssues, ...volumeAssessments.flatMap(item => item.issues), ...stringArray(parsed.issues)])]
  }
}
