import { volumeChapterDAO, workDAO } from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import type { StoryGoalConfig } from './story-goal-checker'
import { withGoalLoopModelOptions } from './story-goal-model'
import { formatGenrePolicy, resolveStoryGenrePolicy } from './story-genre-policy'
import { detectStoryMetaResidues } from './story-continuity-gate'
import { formatStoryContractForPrompt } from './story-contract'
import { requestStructuredModelOutput } from './structured-model-output'

export type StoryWeakestLayer = 'storyline' | 'beat' | 'scene' | 'paragraph'
export type StoryForensicScope = 'sentence' | 'scene' | 'beat_cluster' | 'story_engine'

export interface StoryForensicIssue {
  code: string
  scope: StoryForensicScope
  chapterTitles: string[]
  repairChapterTitles: string[]
  evidence: string[]
  message: string
  repairable: boolean
  recommendedAction: string
}

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
  hardBlockers: string[]
  forensicIssues: StoryForensicIssue[]
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
const STORY_CHUNK_SUMMARY_SCHEMA = {
  type: 'object',
  required: ['summary', 'promises', 'payoffs', 'issues'],
  properties: {
    summary: { type: 'string' }, promises: { type: 'array' },
    payoffs: { type: 'array' }, issues: { type: 'array' }
  }
}
const STORY_PROSE_BLIND_SCHEMA = {
  type: 'object',
  required: ['score', 'reason', 'issues'],
  properties: { score: { type: 'integer' }, reason: { type: 'string' }, issues: { type: 'array' } }
}
const STORY_WHOLE_EVALUATION_SCHEMA = {
  type: 'object',
  required: [
    'goal_match_score', 'goal_match_reason', 'overall_story_score', 'overall_story_reason',
    'preview_hook_score', 'preview_hook_reason', 'weakest_layer', 'weak_chapter_titles', 'issues'
  ],
  properties: {
    goal_match_score: { type: 'integer' }, goal_match_reason: { type: 'string' },
    overall_story_score: { type: 'integer' }, overall_story_reason: { type: 'string' },
    preview_hook_score: { type: 'integer' }, preview_hook_reason: { type: 'string' },
    weakest_layer: { type: 'string' }, weak_chapter_titles: { type: 'array' }, issues: { type: 'array' }
  }
}
const STORY_FORENSIC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hard_blockers: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: {
            type: 'string',
            enum: [
              'TIMELINE_CONTRADICTION', 'SPATIAL_JUMP', 'DUPLICATED_EVENT',
              'EVIDENCE_STATE_REGRESSION', 'KNOWLEDGE_REGRESSION', 'OBSTACLE_BYPASS',
              'DEUS_EX_MACHINA', 'UNPAYED_CORE_PROMISE', 'UNFORESHADOWED_NEW_ARC',
              'META_RESIDUE', 'BROKEN_CLIMAX_MECHANISM', 'OTHER_HARD_BLOCKER'
            ]
          },
          scope: { type: 'string', enum: ['sentence', 'scene', 'beat_cluster', 'story_engine'] },
          chapter_titles: { type: 'array', items: { type: 'string' } },
          repair_chapter_titles: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
          repairable: { type: 'boolean' },
          recommended_action: { type: 'string' }
        },
        required: [
          'code', 'scope', 'chapter_titles', 'repair_chapter_titles',
          'evidence', 'message', 'repairable', 'recommended_action'
        ]
      }
    }
  },
  required: ['hard_blockers']
} as const

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
  let parsed: Record<string, unknown>
  try {
    parsed = await requestStructuredModelOutput<Record<string, unknown>>({
      workId,
      label: `整篇评审分段摘要 ${chunk.range}`,
      signal,
      request: (attempt, error) => modelService.chat(
        withGoalLoopModelOptions(workId, {
          workId,
          step: 'story_whole_chunk_summary',
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          temperature: 0,
          maxTokens: 1800,
          forceThinkingDisabled: true,
          responseSchema: { name: 'story_chunk_summary', schema: STORY_CHUNK_SUMMARY_SCHEMA, strict: false },
          systemPrompt: [
            '你是短故事整篇评审的证据提取员。只提取文本中实际发生的内容，不补写，不给虚高评价。',
            '只输出 JSON：{"summary":"因果剧情摘要","promises":["读者承诺/悬念"],"payoffs":["已兑现内容"],"issues":["结构或连续性问题"]}'
          ].join('\n'),
          prompt: [
            `【范围】${chunk.range}\n\n【正文】\n${chunk.text}`,
            attempt > 1 ? `【格式重试】${error}。缩短摘要并返回完整 JSON。` : ''
          ].filter(Boolean).join('\n\n')
        }),
        { stream: false, signal }
      )
    })
  } catch (error) {
    return {
      range: chunk.range,
      summary: `${chunk.text.slice(0, 900)}\n…\n${chunk.text.slice(-900)}`,
      promises: [],
      payoffs: [],
      issues: [`分段摘要评估器失败，已保留首尾原文证据：${error instanceof Error ? error.message : String(error)}`]
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

function continuityBoundaryEvidence(blocks: Array<{ title: string; text: string }>): string {
  return blocks.map((block, index) => {
    const previous = index > 0 ? blocks[index - 1] : null
    return [
      `【边界 ${index + 1}：${previous?.title ?? '全篇开头'} → ${block.title}】`,
      previous ? `上一拍结尾：\n${previous.text.slice(-1600)}` : '',
      `本拍开头：\n${block.text.slice(0, 2000)}`
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}

async function assessStoryForensics(
  workId: number,
  blocks: Array<{ title: string; outline: string; text: string }>,
  mergedBody: string,
  extractedEvidence: string,
  signal?: AbortSignal
): Promise<StoryForensicIssue[]> {
  const deterministic: StoryForensicIssue[] = blocks.flatMap(block =>
    detectStoryMetaResidues(block.text).map(message => ({
      code: 'META_RESIDUE',
      scope: 'sentence' as const,
      chapterTitles: [block.title],
      repairChapterTitles: [block.title],
      evidence: [message],
      message,
      repairable: true,
      recommendedAction: '只改写生成提示残留，保留剧情事实'
    }))
  )
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_forensic_audit',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 1800,
      responseSchema: { name: 'story_forensic_audit', schema: STORY_FORENSIC_JSON_SCHEMA, strict: true },
      systemPrompt: [
        '你是短故事整篇法医审计员。只报告有原文证据、足以否决成稿的硬伤，不评价文笔，不用小瑕疵凑数。',
        '硬伤包括：时间线互相矛盾；人物或道具空间无过渡跳变；同一关键事件重复发生；证据状态/人物知识倒退；前文制造的关键阻碍被后文直接跳过；主角胜利依赖反派降智、临时权威、巧合或终局新证据；核心承诺未回收；结尾突然开启未经铺垫的新主线；生成提示残留。',
        '证据流程略有戏剧化可以接受，但若证据本身无法证明主张，或处理结果无任何已铺垫依据，属于硬伤。',
        '逐项核对故事合同 rule_proofs：正文中的制度执行者、触发条件、所需证据和后果必须一致；若核心压迫只靠一条现实中无法执行、主角可轻易拒绝或申诉绕开的规则，属于 BROKEN_CLIMAX_MECHANISM。',
        '逐项核对 climax_evidence_chain：证据必须按约定来源和持有人提前出现，并由人物动作触发。自动弹文件、恰好群发短信、临时权威背书、主角此前不知道的新证据均属于 DEUS_EX_MACHINA。',
        'code 必须从以下固定集合选择：TIMELINE_CONTRADICTION、SPATIAL_JUMP、DUPLICATED_EVENT、EVIDENCE_STATE_REGRESSION、KNOWLEDGE_REGRESSION、OBSTACLE_BYPASS、DEUS_EX_MACHINA、UNPAYED_CORE_PROMISE、UNFORESHADOWED_NEW_ARC、META_RESIDUE、BROKEN_CLIMAX_MECHANISM、OTHER_HARD_BLOCKER。',
        'scope 只允许 sentence/scene/beat_cluster/story_engine。chapter_titles 是证据位置，repair_chapter_titles 是实际必须修改的最小节拍集。',
        '单句时间/数字错误用sentence；单场证据或知情断裂用scene；需要“前面铺垫+后面兑现”联动用beat_cluster；合同或高潮机制本身不可行才用story_engine。',
        '只输出 JSON：{"hard_blockers":[{"code":"TIMELINE_CONTRADICTION","scope":"sentence","chapter_titles":["原样标题"],"repair_chapter_titles":["原样标题"],"evidence":["证据A","证据B"],"message":"硬伤说明","repairable":true,"recommended_action":"最小修复动作"}]}。无硬伤输出空数组。'
      ].join('\n\n'),
      prompt: [
        formatStoryContractForPrompt(workId),
        `【节拍蓝图】\n${JSON.stringify(blocks.map((block, index) => ({
          ref: block.title === '导语' ? '导语' : `第${index + (blocks[0]?.title === '导语' ? 0 : 1)}拍`,
          title: block.title,
          outline: block.outline
        })), null, 2)}`,
        extractedEvidence,
        continuityBoundaryEvidence(blocks),
        `【全篇结尾】\n${mergedBody.slice(-5200)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  const evaluatorError = (message: string): StoryForensicIssue => ({
    code: 'FORENSIC_EVALUATOR_ERROR', scope: 'story_engine', chapterTitles: [], repairChapterTitles: [],
    evidence: [message], message: '整篇法医审计结果无法验证', repairable: false,
    recommendedAction: '重试审计，不得因评估器失败删除正文'
  })
  if (!response.success || !response.content?.trim()) {
    return [...deterministic, evaluatorError(response.error || '整篇法医审计无返回')]
  }
  try {
    const parsed = parseJsonObject(response.content)
    if (!parsed) throw new Error('整篇法医审计返回格式无效')
    if (!Array.isArray(parsed.hard_blockers)) throw new Error('整篇法医审计缺少 hard_blockers 数组')
    const rawIssues = parsed.hard_blockers.slice(0, 12)
    const storyBlocks = blocks.filter(block => block.title !== '导语')
    const resolveTitles = (value: unknown): string[] => {
      const values = Array.isArray(value) ? value.map(String) : []
      return [...new Set(values.flatMap(item => {
        const exact = blocks.find(block => block.title === item.trim())
        if (exact) return [exact.title]
        const ordinal = /第(\d+)拍/.exec(item)?.[1]
        if (ordinal) return [storyBlocks[Number(ordinal) - 1]?.title].filter(Boolean) as string[]
        return blocks.filter(block => block.title.includes(item) || item.includes(block.title)).map(block => block.title)
      }))]
    }
    const aiIssues = rawIssues.map((item, index): StoryForensicIssue | null => {
      if (typeof item === 'string') {
        const titles = resolveTitles([item])
        return {
          code: `FORENSIC_${index + 1}`, scope: 'beat_cluster', chapterTitles: titles,
          repairChapterTitles: titles, evidence: [item], message: item, repairable: true,
          recommendedAction: '修复定位节拍及必要铺垫，再做整篇复验'
        }
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const row = item as Record<string, unknown>
      const rawScope = String(row.scope ?? '')
      const scope: StoryForensicScope = ['sentence', 'scene', 'beat_cluster', 'story_engine'].includes(rawScope)
        ? rawScope as StoryForensicScope : 'beat_cluster'
      const chapterTitles = resolveTitles(row.chapter_titles)
      const repairTitles = resolveTitles(row.repair_chapter_titles)
      const message = String(row.message ?? '').trim()
      if (!message) return null
      return {
        code: String(row.code ?? `FORENSIC_${index + 1}`).trim() || `FORENSIC_${index + 1}`,
        scope,
        chapterTitles,
        repairChapterTitles: repairTitles.length > 0 ? repairTitles : chapterTitles,
        evidence: stringList(row.evidence, 6),
        message,
        // 是否需要发动机级重建由 scope 决定，避免模型把可局部修复的问题误标成不可修复。
        repairable: scope !== 'story_engine',
        recommendedAction: String(row.recommended_action ?? '').trim() || '按最小作用域修复并整篇复验'
      }
    }).filter((item): item is StoryForensicIssue => item != null)
    if (aiIssues.length !== rawIssues.length) throw new Error('整篇法医审计包含无效问题项')
    const unique = new Map<string, StoryForensicIssue>()
    for (const item of [...deterministic, ...aiIssues]) {
      const key = `${item.code}:${item.repairChapterTitles.join(',')}:${item.message}`
      if (!unique.has(key)) unique.set(key, item)
    }
    return [...unique.values()]
  } catch {
    return [...deterministic, evaluatorError('整篇法医审计返回格式无效')]
  }
}

async function assessProseBlindRead(
  workId: number,
  mergedBody: string,
  genreText: string,
  signal?: AbortSignal
): Promise<ProseBlindRead> {
  const policy = resolveStoryGenrePolicy(genreText)
  const proseEvidence = mergedBody.length <= DIRECT_BODY_CHAR_LIMIT
    ? `【匿名完整正文】\n${mergedBody}`
    : blindReadSamples(mergedBody)
  const parsed = await requestStructuredModelOutput<Record<string, unknown>>({
    workId,
    label: '原文盲读',
    signal,
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'story_prose_blind_read',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens: 1800,
        forceThinkingDisabled: true,
        responseSchema: { name: 'story_prose_blind_read', schema: STORY_PROSE_BLIND_SCHEMA, strict: false },
        systemPrompt: [
          '你是独立短故事盲读编辑。你看不到标题、大纲、评分表和剧情摘要，只按普通读者阅读原文切片。',
          '重点识别：残句、错词、标点或对话边界破损、第一/第三人称漂移、重复心理和身体反应、解释过度、电报短句、模板化刺激、人物声音雷同、场景原地踏步、巧合和作者强行安排。',
          '只要存在读者一眼可见的残句、乱码式错词或叙事人称漂移，score 不得高于 69，issues 必须引用对应原文。',
          '格式完整、反转数量和问号不能加分。只有自然、可信、能让人继续读的原文才能高分。',
          formatGenrePolicy(policy, 'evaluationRules'),
          '只输出 JSON：{"score":75,"reason":"一句话总评","issues":["带原文现象的具体问题"]}'
        ].join('\n\n'),
        prompt: [
          proseEvidence,
          attempt > 1 ? `【格式重试】${error}。返回更短的完整 JSON。` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
  })
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
  signal?: AbortSignal,
  onProgress?: (message: string) => void
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
      issues: ['尚无正文'],
      hardBlockers: ['尚无正文'],
      forensicIssues: []
    }
  }

  let evidence: string
  if (mergedBody.length <= DIRECT_BODY_CHAR_LIMIT) {
    evidence = `【完整正文】\n${mergedBody}`
  } else {
    const summaries: StoryChunkSummary[] = []
    const chunks = splitStoryChunks(publishedBlocks)
    for (const [index, chunk] of chunks.entries()) {
      if (signal?.aborted) throw new Error('已取消')
      onProgress?.(`目标验收：正在压缩整篇证据 ${index + 1}/${chunks.length}`)
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
  onProgress?.('目标验收：正在进行整篇原文盲读')
  const proseRead = await assessProseBlindRead(workId, mergedBody, genreText, signal)
  onProgress?.('目标验收：正在进行时间线、证据链与巧合法医审计')
  const forensicIssues = await assessStoryForensics(workId, publishedBlocks, mergedBody, evidence, signal)
  const hardBlockers = forensicIssues.map(issue =>
    `${issue.code}：${issue.message}${issue.evidence.length > 0 ? `（${issue.evidence.join('；')}）` : ''}`
  )

  onProgress?.('目标验收：正在进行整篇结构、目标匹配与追读力终审')
  const parsed = await requestStructuredModelOutput<Record<string, unknown>>({
    workId,
    label: '整篇终审',
    signal,
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_whole_evaluation',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 3200,
      forceThinkingDisabled: true,
      responseSchema: { name: 'story_whole_evaluation', schema: STORY_WHOLE_EVALUATION_SCHEMA, strict: false },
      systemPrompt: [
        '你是独立短故事终审主编。必须依据给出的正文或逐段证据评估整篇，而不是按局部文笔印象给分。',
        '重点检查：开篇承诺、因果升级、中段变化、人物选择、高潮兑现、伏笔回收、结局闭环与余味。',
        '对手必须基于自身信息做出至少一次有效反制并造成真实损害；主角必须因此调整计划。若对手只挑衅、自曝、拆开明知危险的证据或等待公开处刑，整篇不得高分。',
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
        `【结尾证据】\n${ending}`,
        hardBlockers.length > 0 ? `【法医审计硬伤 - 不得忽略】\n${hardBlockers.join('\n')}` : '',
        attempt > 1 ? `【格式重试】${error}。压缩理由并返回完整 JSON。` : ''
      ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
  })

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
    issues: [...hardBlockers, ...stringList(parsed.issues, 10), ...proseRead.issues].slice(0, 16),
    hardBlockers,
    forensicIssues
  }
}
