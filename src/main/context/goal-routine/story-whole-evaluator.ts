import { volumeChapterDAO, workDAO } from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import type { StoryGoalConfig } from './story-goal-checker'
import { withGoalLoopModelOptions } from './story-goal-model'
import { formatGenrePolicy, resolveStoryGenrePolicy } from './story-genre-policy'

export type StoryWeakestLayer = 'storyline' | 'beat' | 'scene' | 'paragraph'

export interface StoryWholeAssessment {
  goalMatchScore: number
  goalMatchReason: string
  overallStoryScore: number
  overallStoryReason: string
  previewHookScore: number
  previewHookReason: string
  proseReadScore: number
  proseReadReason: string
  weakestLayer: StoryWeakestLayer
  weakChapterTitles: string[]
  issues: string[]
}

interface ProseBlindRead {
  score: number
  reason: string
  issues: string[]
}

interface StoryChunkSummary {
  range: string
  summary: string
  promises: string[]
  payoffs: string[]
  issues: string[]
}

const CHUNK_CHAR_LIMIT = 12_000
const DIRECT_BODY_CHAR_LIMIT = 18_000

function clampScore(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
}

function stringList(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item).trim()).filter(Boolean).slice(0, limit)
}

function normalizeLayer(value: unknown): StoryWeakestLayer {
  const layer = String(value ?? '').toLowerCase()
  if (layer === 'storyline' || layer === 'beat' || layer === 'scene' || layer === 'paragraph') return layer
  return 'scene'
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const json = extractJsonText(content.trim()) ?? content.match(/(\{[\s\S]*\})/)?.[1]
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function chapterBlocks(workId: number): Array<{ title: string; outline: string; text: string }> {
  return volumeChapterDAO.listChaptersByWork(workId)
    .filter(chapter => chapter.content?.trim())
    .map(chapter => ({
      title: chapter.title,
      outline: chapter.outline?.trim() ?? '',
      text: `# ${chapter.title}\n${chapter.content?.trim() ?? ''}`
    }))
}

function splitStoryChunks(blocks: Array<{ title: string; text: string }>): Array<{ range: string; text: string }> {
  const chunks: Array<{ range: string; text: string }> = []
  let current: string[] = []
  let titles: string[] = []
  let size = 0

  const flush = () => {
    if (current.length === 0) return
    chunks.push({ range: titles.join(' → '), text: current.join('\n\n') })
    current = []
    titles = []
    size = 0
  }

  for (const block of blocks) {
    if (block.text.length <= CHUNK_CHAR_LIMIT) {
      if (size > 0 && size + block.text.length > CHUNK_CHAR_LIMIT) flush()
      current.push(block.text)
      titles.push(block.title)
      size += block.text.length
      continue
    }

    flush()
    for (let start = 0; start < block.text.length; start += CHUNK_CHAR_LIMIT) {
      const part = block.text.slice(start, start + CHUNK_CHAR_LIMIT)
      chunks.push({
        range: `${block.title}（${Math.floor(start / CHUNK_CHAR_LIMIT) + 1}）`,
        text: part
      })
    }
  }
  flush()
  return chunks
}

async function summarizeChunk(
  workId: number,
  chunk: { range: string; text: string },
  signal?: AbortSignal
): Promise<StoryChunkSummary> {
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_whole_chunk_summary',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 1400,
      systemPrompt: [
        '你是短故事整篇评审的证据提取员。只提取文本中实际发生的内容，不补写，不给虚高评价。',
        '只输出 JSON：{"summary":"因果剧情摘要","promises":["读者承诺/悬念"],"payoffs":["已兑现内容"],"issues":["结构或连续性问题"]}'
      ].join('\n'),
      prompt: `【范围】${chunk.range}\n\n【正文】\n${chunk.text}`
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) {
    throw new Error(res.error || `整篇评审分段摘要失败：${chunk.range}`)
  }
  const parsed = parseJsonObject(res.content)
  if (!parsed) {
    return {
      range: chunk.range,
      summary: res.content.trim().slice(0, 1600),
      promises: [],
      payoffs: [],
      issues: ['分段摘要未返回结构化 JSON']
    }
  }
  return {
    range: chunk.range,
    summary: String(parsed.summary ?? '').trim(),
    promises: stringList(parsed.promises),
    payoffs: stringList(parsed.payoffs),
    issues: stringList(parsed.issues)
  }
}

function boundaryExcerpt(text: string, ratio: number, radius = 1800): string {
  if (!text.trim()) return ''
  const safeRatio = Math.max(0.05, Math.min(0.95, ratio))
  const point = Math.round(text.length * safeRatio)
  return text.slice(Math.max(0, point - radius), Math.min(text.length, point + radius))
}

function blindReadSamples(text: string): string {
  const sampleSize = 1700
  const points = [0, 0.25, 0.5, 0.75, 1]
  return points.map((ratio, index) => {
    const center = Math.round(text.length * ratio)
    const start = ratio === 0 ? 0 : ratio === 1 ? Math.max(0, text.length - sampleSize) : Math.max(0, center - Math.floor(sampleSize / 2))
    return `【匿名原文切片${index + 1}】\n${text.slice(start, start + sampleSize)}`
  }).join('\n\n')
}

async function assessProseBlindRead(
  workId: number,
  mergedBody: string,
  genreText: string,
  signal?: AbortSignal
): Promise<ProseBlindRead> {
  const policy = resolveStoryGenrePolicy(genreText)
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_prose_blind_read',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 1500,
      systemPrompt: [
        '你是独立短故事盲读编辑。你看不到标题、大纲、评分表和剧情摘要，只按普通读者阅读原文切片。',
        '重点识别：重复心理和身体反应、解释过度、电报短句、模板化刺激、人物声音雷同、场景原地踏步、巧合和作者强行安排。',
        '格式完整、反转数量和问号不能加分。只有自然、可信、能让人继续读的原文才能高分。',
        formatGenrePolicy(policy, 'evaluationRules'),
        '只输出 JSON：{"score":75,"reason":"一句话总评","issues":["带原文现象的具体问题"]}'
      ].join('\n\n'),
      prompt: blindReadSamples(mergedBody)
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) throw new Error(res.error || '原文盲读失败')
  const parsed = parseJsonObject(res.content)
  if (!parsed) throw new Error('原文盲读返回 JSON 解析失败')
  return {
    score: clampScore(parsed.score),
    reason: String(parsed.reason ?? '').trim(),
    issues: stringList(parsed.issues, 8)
  }
}

function storyModeGuidance(text: string): string {
  if (/悬疑|推理|刑侦|惊悚|谜案/.test(text)) {
    return '悬疑/推理：重点评估线索公平性、信息控制、误导与真相回收；不能用单纯情绪烈度替代推理兑现。'
  }
  if (/喜剧|搞笑|沙雕|幽默/.test(text)) {
    return '喜剧：重点评估铺垫—误导—回收、人物反应差和笑点升级；不能强迫每拍都走羞辱打脸。'
  }
  if (/现实|家庭|职场|社会|治愈|文学/.test(text)) {
    return '现实/情感：重点评估人物选择、关系变化、细节可信度和余味；允许克制，不得把情绪克制误判为低张力。'
  }
  if (/言情|爱情|婚恋|甜宠|虐恋/.test(text)) {
    return '言情/关系：重点评估吸引与阻碍、关系阶段变化、误会合理性和情感兑现；不能只统计反转数量。'
  }
  return '爽感/反转：重点评估压迫—反击的因果、信息差递进、爽点兑现和代价；避免重复打脸造成边际递减。'
}

export async function assessWholeStory(
  workId: number,
  config: StoryGoalConfig,
  signal?: AbortSignal
): Promise<StoryWholeAssessment> {
  const blocks = chapterBlocks(workId)
  const work = workDAO.getById(workId)
  const publishedBlocks = work?.description?.trim()
    ? [{ title: '导语', outline: '发布时位于第一节拍之前的前台钩子', text: `# 导语\n${work.description.trim()}` }, ...blocks]
    : blocks
  const mergedBody = publishedBlocks.map(block => block.text).join('\n\n')
  if (!mergedBody.trim()) {
    return {
      goalMatchScore: config.goalDescription.trim() ? 0 : 100,
      goalMatchReason: '尚无正文',
      overallStoryScore: 0,
      overallStoryReason: '尚无正文',
      previewHookScore: 0,
      previewHookReason: '尚无正文',
      proseReadScore: 0,
      proseReadReason: '尚无正文',
      weakestLayer: 'storyline',
      weakChapterTitles: [],
      issues: ['尚无正文']
    }
  }

  let evidence: string
  if (mergedBody.length <= DIRECT_BODY_CHAR_LIMIT) {
    evidence = `【完整正文】\n${mergedBody}`
  } else {
    const summaries: StoryChunkSummary[] = []
    for (const chunk of splitStoryChunks(publishedBlocks)) {
      if (signal?.aborted) throw new Error('已取消')
      summaries.push(await summarizeChunk(workId, chunk, signal))
    }
    evidence = `【逐段证据摘要】\n${JSON.stringify(summaries, null, 2)}`
  }

  const outline = publishedBlocks.map((block, index) => ({
    index: index + 1,
    title: block.title,
    outline: block.outline.slice(0, 1600)
  }))
  const opening = mergedBody.slice(0, 4200)
  const ending = mergedBody.slice(-5200)
  const preview = boundaryExcerpt(mergedBody, config.previewRatio)
  const modeGuidance = storyModeGuidance([
    work?.genre ?? '',
    work?.tags ?? '',
    config.goalDescription
  ].join('\n'))
  const genreText = [work?.genre ?? '', work?.tags ?? '', config.goalDescription].join('\n')
  const proseRead = await assessProseBlindRead(workId, mergedBody, genreText, signal)

  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_whole_evaluation',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 2600,
      systemPrompt: [
        '你是独立短故事终审主编。必须依据给出的正文或逐段证据评估整篇，而不是按局部文笔印象给分。',
        '重点检查：开篇承诺、因果升级、中段变化、人物选择、高潮兑现、伏笔回收、结局闭环与余味。',
        'preview_hook_score 判断目标试读点结束时，读者是否已经获得阶段兑现，同时产生继续阅读的具体问题；不能只因问号、感叹号或刺激词给高分。',
        'weakest_layer 只能是 storyline、beat、scene、paragraph；选择真正应返工的最高层级。',
        '只输出合法 JSON。分数为 0-100 整数，不得因为格式完整而默认高分。',
        '格式：{"goal_match_score":80,"goal_match_reason":"...","overall_story_score":80,"overall_story_reason":"...","preview_hook_score":80,"preview_hook_reason":"...","weakest_layer":"scene","weak_chapter_titles":["..."],"issues":["..."]}'
      ].join('\n'),
      prompt: [
        `【作品】${work?.title || '未命名短故事'}`,
        `【题材专用评审准则】\n${modeGuidance}`,
        `【用户创作目标】\n${config.goalDescription.trim() || '高完读率、因果完整、情绪与反转有效兑现的短故事'}`,
        `【节拍蓝图】\n${JSON.stringify(outline, null, 2)}`,
        evidence,
        `【开篇证据】\n${opening}`,
        `【${Math.round(config.previewRatio * 100)}% 试读边界前后】\n${preview}`,
        `【结尾证据】\n${ending}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )

  if (!res.success || !res.content?.trim()) {
    throw new Error(res.error || '整篇终审失败')
  }
  const parsed = parseJsonObject(res.content)
  if (!parsed) throw new Error('整篇终审返回 JSON 解析失败')

  return {
    goalMatchScore: config.goalDescription.trim() ? clampScore(parsed.goal_match_score) : 100,
    goalMatchReason: String(parsed.goal_match_reason ?? '').trim(),
    overallStoryScore: clampScore(parsed.overall_story_score),
    overallStoryReason: String(parsed.overall_story_reason ?? '').trim(),
    previewHookScore: clampScore(parsed.preview_hook_score),
    previewHookReason: String(parsed.preview_hook_reason ?? '').trim(),
    proseReadScore: proseRead.score,
    proseReadReason: proseRead.reason,
    weakestLayer: normalizeLayer(parsed.weakest_layer),
    weakChapterTitles: stringList(parsed.weak_chapter_titles, 4),
    issues: [...stringList(parsed.issues, 10), ...proseRead.issues].slice(0, 12)
  }
}
