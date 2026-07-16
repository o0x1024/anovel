import { modelService } from '../../model'
import { volumeChapterDAO } from '../../db'
import { extractJsonText } from '../parse-json-extract'
import { withGoalLoopModelOptions } from './story-goal-model'
import { retentionEvaluationRules } from './reader-retention'
import { assessNovelSystemics } from './novel-systemic-gate'
import type { NovelSystemIssue } from '../../../shared/novel-systemic-types'

export interface VolumeAssessment {
  volume: string
  structureScore: number
  escalationScore: number
  payoffScore: number
  continuityScore: number
  repetitionScore: number
  issues: string[]
  evidenceIssues: VolumeEvidenceIssue[]
  weakChapters: string[]
  summary: string
}

export interface VolumeEvidenceIssue {
  problem: string
  chapterTitles: string[]
  evidence: string[]
  requiredFix: string
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
  systemicIssues: NovelSystemIssue[]
}

function clampScore(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    : []
}

function volumeEvidenceIssues(value: unknown): VolumeEvidenceIssue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const problem = String(row.problem ?? '').trim()
    const chapterTitles = stringArray(row.chapterTitles ?? row.chapter_titles)
    const evidence = stringArray(row.evidence)
    const requiredFix = String(row.requiredFix ?? row.required_fix ?? '').trim()
    if (!problem || chapterTitles.length === 0 || evidence.length === 0 || !requiredFix) return []
    return [{ problem, chapterTitles, evidence, requiredFix }]
  })
}

function compactEvidence(value: string): string {
  return value.replace(/[\s“”‘’'"《》]/g, '')
}

function validateVolumeEvidenceIssues(
  issues: VolumeEvidenceIssue[],
  chapters: ReturnType<typeof volumeChapterDAO.listChaptersByWork>
): { valid: VolumeEvidenceIssue[]; invalid: string[] } {
  const valid: VolumeEvidenceIssue[] = []
  const invalid: string[] = []
  for (const issue of issues) {
    const matched = chapters.filter(chapter => issue.chapterTitles.some(title =>
      chapter.title === title || chapter.title.includes(title) || title.includes(chapter.title)
    ))
    const bodies = matched.map(chapter => compactEvidence(chapter.content ?? ''))
    if (matched.length === 0 || issue.evidence.some(value => !bodies.some(body => body.includes(compactEvidence(value))))) {
      invalid.push(`${issue.problem}：章节或原文证据无法定位`)
      continue
    }
    valid.push(issue)
  }
  return { valid, invalid }
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

function volumeAssessmentIssues(
  assessment: VolumeAssessment,
  chapters: ReturnType<typeof volumeChapterDAO.listChaptersByWork>
): NovelSystemIssue[] {
  const volumeChapters = chapters.filter(chapter => chapter.volume_name === assessment.volume)
  const evidenceChapterIds = [...new Set(assessment.evidenceIssues.flatMap(item =>
    item.chapterTitles.flatMap(title => volumeChapters
      .filter(chapter => chapter.title === title || chapter.title.includes(title) || title.includes(chapter.title))
      .map(chapter => chapter.id))
  ))]
  const chapterIds = evidenceChapterIds
  const scoreEvidence = [
    `结构${assessment.structureScore}`,
    `升级${assessment.escalationScore}`,
    `兑现${assessment.payoffScore}`,
    `连续性${assessment.continuityScore}`,
    `反重复${assessment.repetitionScore}`
  ]
  const issues: NovelSystemIssue[] = []
  const evidence = assessment.evidenceIssues.flatMap(item =>
    item.evidence.map(value => `${item.chapterTitles.join('、')}：${value}`)
  )
  const lowScore = assessment.structureScore < 80
    || assessment.escalationScore < 78
    || assessment.payoffScore < 80
    || assessment.continuityScore < 85
    || assessment.repetitionScore < 80
  if (lowScore && (assessment.evidenceIssues.length === 0 || chapterIds.length === 0)) {
    issues.push({
      code: 'EVALUATOR_ERROR',
      scope: 'volume',
      severity: 'warning',
      chapterIds: volumeChapters.slice(-2).map(chapter => chapter.id),
      evidence: scoreEvidence,
      message: `${assessment.volume}终审给出低分但没有可定位的章节原文证据`,
      recommendedAction: '重新运行评估器；没有章节标题和原文证据时禁止自动改写正文'
    })
    return issues
  }
  if (assessment.structureScore < 80 || assessment.escalationScore < 78 || assessment.continuityScore < 85) {
    issues.push({
      code: 'VOLUME_NO_CLOSURE',
      scope: 'volume',
      severity: 'blocker',
      chapterIds,
      evidence: [...scoreEvidence, ...evidence],
      message: `${assessment.volume}的因果闭环、压力升级或连续性未达到分卷交付线`,
      recommendedAction: '重排本卷薄弱章节群，建立目标→受阻→代价→阶段结果的因果链'
    })
  }
  if (assessment.payoffScore < 80) {
    issues.push({
      code: 'CLIMAX_NO_COST',
      scope: 'volume',
      severity: 'blocker',
      chapterIds,
      evidence: [...scoreEvidence, ...evidence],
      message: `${assessment.volume}的阶段兑现或不可逆代价不足`,
      recommendedAction: '重写高潮及其前置因果，让胜利付出并保留真实后果'
    })
  }
  if (assessment.repetitionScore < 80) {
    issues.push({
      code: 'REPEATED_SOLUTION',
      scope: 'cluster',
      severity: 'blocker',
      chapterIds,
      evidence: [...scoreEvidence, ...evidence],
      message: `${assessment.volume}的冲突解法、场景或钩子存在系统性同构重复`,
      recommendedAction: '按章节模式指纹重排冲突类型、主角方法、对手调整和代价'
    })
  }
  return issues
}

async function assessVolumeWindow(
  workId: number,
  volumeName: string,
  chapters: ReturnType<typeof volumeChapterDAO.listChaptersByWork>,
  windowIndex: number,
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
        retentionEvaluationRules('novel'),
        '每个问题必须给出准确章节标题、正文抽样中逐字可见的证据和可执行修复要求；没有证据不得列为问题或压低分数。',
        '只输出 JSON：{"structureScore":0,"escalationScore":0,"payoffScore":0,"continuityScore":0,"repetitionScore":0,"issues":[{"problem":"","chapterTitles":["完整章节标题"],"evidence":["原文证据"],"requiredFix":""}],"weakChapters":[],"summary":""}'
      ].join('\n'),
      prompt: `【分卷】${volumeName}\n【连续窗口】${windowIndex + 1}（${chapters[0]?.title} → ${chapters.at(-1)?.title}）\n\n${chapters.map(chapterEvidence).join('\n\n')}`
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`${volumeName}第${windowIndex + 1}窗口终审失败：${response.error || '模型未返回内容'}`)
  }
  const parsed = parseObject(response.content, `${volumeName}终审`)
  const parsedEvidenceIssues = volumeEvidenceIssues(parsed.issues)
  const evidenceValidation = validateVolumeEvidenceIssues(parsedEvidenceIssues, chapters)
  const evidenceIssues = evidenceValidation.valid
  return {
    volume: volumeName,
    structureScore: clampScore(parsed.structureScore),
    escalationScore: clampScore(parsed.escalationScore),
    payoffScore: clampScore(parsed.payoffScore),
    continuityScore: clampScore(parsed.continuityScore),
    repetitionScore: clampScore(parsed.repetitionScore),
    issues: [
      ...(evidenceIssues.length > 0 ? evidenceIssues.map(issue => issue.problem) : stringArray(parsed.issues)),
      ...evidenceValidation.invalid
    ],
    evidenceIssues,
    weakChapters: [...new Set([
      ...stringArray(parsed.weakChapters),
      ...evidenceIssues.flatMap(issue => issue.chapterTitles)
    ])],
    summary: String(parsed.summary ?? '').trim()
  }
}

/** 全覆盖分卷正文终审：每8章一组，最终再聚合卷首/卷末与全部窗口报告。 */
export async function assessNovelVolume(
  workId: number,
  volumeName: string,
  chapters: ReturnType<typeof volumeChapterDAO.listChaptersByWork>,
  signal?: AbortSignal
): Promise<VolumeAssessment> {
  const windows: typeof chapters[] = []
  for (let index = 0; index < chapters.length; index += 8) windows.push(chapters.slice(index, index + 8))
  const assessments: VolumeAssessment[] = []
  for (let index = 0; index < windows.length; index++) {
    if (signal?.aborted) throw new Error('已取消')
    assessments.push(await assessVolumeWindow(workId, volumeName, windows[index], index, signal))
  }
  if (assessments.length === 1) return assessments[0]

  const volume = volumeChapterDAO.listVolumes(workId).find(item => item.name === volumeName)
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_novel_volume_evaluation',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      maxTokens: 2200,
      systemPrompt: [
        '你是长篇小说分卷聚合终审。依据全部连续窗口报告和卷首卷末证据，判断整卷闭环；不得用局部高分掩盖任一窗口的阻断问题。',
        '必须检查阶段目标、must-resolve承诺、高潮因果、不可逆代价、对手状态变化、允许跨卷债务和禁止新增一级主线后的收束。',
        'repetitionScore 表示反重复健康度，重复越少分数越高；任一确定性重复或状态问题都必须进入issues。',
        '新增问题必须给出准确章节标题和输入证据中的原文；没有证据不得新增阻断问题。',
        '只输出 JSON：{"structureScore":0,"escalationScore":0,"payoffScore":0,"continuityScore":0,"repetitionScore":0,"issues":[{"problem":"","chapterTitles":["完整章节标题"],"evidence":["原文证据"],"requiredFix":""}],"weakChapters":[],"summary":""}'
      ].join('\n'),
      prompt: [
        `【分卷】${volumeName}`,
        volume?.description ? `【分卷闭环合同】\n${volume.description}` : '',
        `【全部窗口报告】\n${JSON.stringify(assessments, null, 2)}`,
        `【卷首证据】\n${chapters.slice(0, 2).map(chapterEvidence).join('\n\n')}`,
        `【卷末证据】\n${chapters.slice(-2).map(chapterEvidence).join('\n\n')}`
      ].filter(Boolean).join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`${volumeName}聚合终审失败：${response.error || '模型未返回内容'}`)
  }
  const parsed = parseObject(response.content, `${volumeName}聚合终审`)
  const aggregateEvidenceValidation = validateVolumeEvidenceIssues(
    volumeEvidenceIssues(parsed.issues),
    chapters
  )
  const aggregateEvidenceIssues = aggregateEvidenceValidation.valid
  const evidenceIssues = [...assessments.flatMap(item => item.evidenceIssues), ...aggregateEvidenceIssues]
  return {
    volume: volumeName,
    structureScore: clampScore(parsed.structureScore),
    escalationScore: clampScore(parsed.escalationScore),
    payoffScore: clampScore(parsed.payoffScore),
    continuityScore: clampScore(parsed.continuityScore),
    repetitionScore: clampScore(parsed.repetitionScore),
    issues: [...new Set([
      ...assessments.flatMap(item => item.issues),
      ...aggregateEvidenceIssues.map(issue => issue.problem),
      ...aggregateEvidenceValidation.invalid,
      ...stringArray(parsed.issues)
    ])],
    evidenceIssues,
    weakChapters: [...new Set([
      ...assessments.flatMap(item => item.weakChapters),
      ...stringArray(parsed.weakChapters),
      ...aggregateEvidenceIssues.flatMap(issue => issue.chapterTitles)
    ])],
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
    volumeAssessments.push(await assessNovelVolume(
      workId,
      volumeName,
      chapters.filter(chapter => chapter.volume_name === volumeName),
      signal
    ))
  }

  const rhythmIssues = deterministicRhythmIssues(chapters)
  const systemic = assessNovelSystemics(workId, { requireFingerprints: true, includeProseScan: true })
  const hardVolumeIssues = volumeAssessments.flatMap(assessment => volumeAssessmentIssues(assessment, chapters))
  const allSystemicIssues = [...systemic.issues, ...hardVolumeIssues]
  const systemicIssueMessages = allSystemicIssues.map(issue => `${issue.code}：${issue.message}（${issue.evidence.join('；')}）`)
  const sampleIndexes = new Set([
    0, 1, 2,
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
        '你是长篇小说整书终审。综合各卷报告与黄金前三章/四分之一/中点/四分之三/结局盲读样本评分。',
        '黄金前三章必须联合检查“第一章立钩子、第二章扩大承诺、第三章首次兑现并打开长线目标”，任一缺失都要列入 issues 和 weakChapterTitles。',
        '重点判断：用户目标是否贯穿、主线是否升级、高潮是否由前文因果触发、结局是否兑现、正文是否有追读感和人味。',
        retentionEvaluationRules('novel'),
        '只输出 JSON：{"goalMatchScore":0,"goalMatchReason":"","overallStoryScore":0,"overallStoryReason":"","previewHookScore":0,"previewHookReason":"","proseReadScore":0,"proseReadReason":"","weakChapterTitles":[],"issues":[]}'
      ].join('\n'),
      prompt: [
        `【用户创作目标】\n${goalDescription.trim() || '无额外目标，以作品既定设定为准'}`,
        `【分卷终审】\n${JSON.stringify(volumeAssessments, null, 2)}`,
        rhythmIssues.length ? `【确定性节奏问题】\n${rhythmIssues.join('\n')}` : '',
        systemicIssueMessages.length ? `【确定性跨章状态与模式问题 - blocker不得被综合分抵消】\n${systemicIssueMessages.join('\n')}` : '',
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
    issues: [...new Set([...rhythmIssues, ...systemicIssueMessages, ...volumeAssessments.flatMap(item => item.issues), ...stringArray(parsed.issues)])],
    systemicIssues: allSystemicIssues
  }
}
