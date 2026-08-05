import { causalNovelDAO, novelReleaseWindowDAO, storyStateDAO, volumeChapterDAO } from '../../db'
import type { NovelReleaseWindowIssueInput } from '../../db'
import { modelService } from '../../model'
import { runResourceConstraintGate } from '../resource-ledger'
import {
  calculateNovelReleaseScore,
  NOVEL_RELEASE_WINDOW_PROTOCOL_VERSION,
  novelReleaseScoreBlockers,
  planCompletedNovelReleaseWindows,
  type NovelReleaseDimensionScores,
  type NovelReleaseScore,
  type NovelReleaseWindowRange
} from '../../../shared/novel-release-window'
import { detectChapterPatternIssues, detectStoryStateIssues } from './novel-systemic-gate'
import { requestStructuredModelOutput } from './structured-model-output'
import { withGoalLoopModelOptions } from './story-goal-model'
import { clearChapterEditorialDebt } from './novel-chapter-transaction-policy'

const RELEASE_WINDOW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'issues', 'summary'],
  properties: {
    scores: {
      type: 'object',
      additionalProperties: false,
      required: [
        'continuity', 'structure', 'hook', 'escalationPayoff',
        'characterEmotion', 'proseRepetition', 'settingNovelty'
      ],
      properties: Object.fromEntries([
        'continuity', 'structure', 'hook', 'escalationPayoff',
        'characterEmotion', 'proseRepetition', 'settingNovelty'
      ].map(key => [key, { type: 'integer', minimum: 0, maximum: 100 }]))
    },
    issues: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'severity', 'chapterTitles', 'evidence', 'message', 'requiredFix'],
        properties: {
          code: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'warning'] },
          chapterTitles: { type: 'array', minItems: 1, items: { type: 'string' } },
          evidence: { type: 'array', minItems: 1, items: { type: 'string' } },
          message: { type: 'string' },
          requiredFix: { type: 'string' }
        }
      }
    },
    summary: { type: 'string' }
  }
}

const RELEASE_WINDOW_EVIDENCE_CORRECTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['corrections'],
  properties: {
    corrections: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issueIndex', 'evidence'],
        properties: {
          issueIndex: { type: 'integer', minimum: 1, maximum: 12 },
          evidence: { type: 'array', minItems: 1, items: { type: 'string' } }
        }
      }
    }
  }
}

interface ParsedReleaseWindowReview {
  scores: NovelReleaseDimensionScores
  issues: NovelReleaseWindowIssueInput[]
  summary: string
}

export interface NovelReleaseWindowAuditResult {
  auditId: number
  snapshotId: number | null
  range: NovelReleaseWindowRange
  passed: boolean
  score: NovelReleaseScore
  blockers: string[]
  summary: string
  issues: NovelReleaseWindowIssueInput[]
}

function compact(value: string): string {
  return value.replace(/[\s“”‘’'"《》]/g, '')
}

class ReleaseWindowEvidenceValidationError extends Error {
  readonly invalidIssues: Array<{
    issueIndex: number
    chapterTitles: string[]
    evidence: string[]
  }>

  constructor(invalidIssues: ReleaseWindowEvidenceValidationError['invalidIssues']) {
    super(`首发窗口问题 ${invalidIssues.map(issue => issue.issueIndex).join('、')} 的证据无法在声明章节正文中定位`)
    this.name = 'ReleaseWindowEvidenceValidationError'
    this.invalidIssues = invalidIssues
  }
}

function parseReleaseWindowReview(
  value: unknown,
  range: NovelReleaseWindowRange
): ParsedReleaseWindowReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('首发窗口审读根节点不是对象')
  const row = value as Record<string, unknown>
  const scoreRow = row.scores as Record<string, unknown> | undefined
  if (!scoreRow || typeof scoreRow !== 'object' || Array.isArray(scoreRow)) throw new Error('首发窗口审读缺少 scores')
  const scores: NovelReleaseDimensionScores = {
    continuity: Number(scoreRow.continuity),
    structure: Number(scoreRow.structure),
    hook: Number(scoreRow.hook),
    escalationPayoff: Number(scoreRow.escalationPayoff),
    characterEmotion: Number(scoreRow.characterEmotion),
    proseRepetition: Number(scoreRow.proseRepetition),
    settingNovelty: Number(scoreRow.settingNovelty)
  }
  const chaptersByTitle = new Map(range.chapters.map(chapter => [chapter.title, chapter]))
  if (!Array.isArray(row.issues)) throw new Error('首发窗口审读缺少 issues')
  const invalidEvidence: ReleaseWindowEvidenceValidationError['invalidIssues'] = []
  const droppedAdvisoryIssues: number[] = []
  const issues = row.issues.flatMap((raw, index): NovelReleaseWindowIssueInput[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`首发窗口问题 ${index + 1} 不是对象`)
    const issue = raw as Record<string, unknown>
    const severity = issue.severity === 'warning' ? 'warning' : 'blocker'
    const titles = Array.isArray(issue.chapterTitles)
      ? issue.chapterTitles.map(String).map(title => title.trim()).filter(Boolean)
      : []
    const chapters = titles.map(title => chaptersByTitle.get(title)).filter(Boolean) as NovelReleaseWindowRange['chapters']
    if (chapters.length !== titles.length || chapters.length === 0) {
      throw new Error(`首发窗口问题 ${index + 1} 引用了不存在的章节标题`)
    }
    const evidence = Array.isArray(issue.evidence)
      ? issue.evidence.map(String).map(text => text.trim()).filter(Boolean)
      : []
    const missingEvidence = evidence.filter(quote => (
      !chapters.some(chapter => compact(chapter.content ?? '').includes(compact(quote)))
    ))
    if (evidence.length === 0 || missingEvidence.length > 0) {
      if (severity === 'blocker') {
        invalidEvidence.push({
          issueIndex: index + 1,
          chapterTitles: titles,
          evidence: missingEvidence.length > 0 ? missingEvidence : evidence
        })
      } else {
        // warning 只能影响编辑建议，不能因为模型把标题元数据或近似引文
        // 当成正文而让整本工作流暂停。评分仍然保留；若评分低于发布线，
        // 下方 SCORE_EVIDENCE_MISSING 会要求重新审读并阻断放行。
        droppedAdvisoryIssues.push(index + 1)
        return []
      }
    }
    const message = String(issue.message ?? '').trim()
    const requiredFix = String(issue.requiredFix ?? '').trim()
    if (!message || !requiredFix) throw new Error(`首发窗口问题 ${index + 1} 缺少问题或修复结果`)
    return {
      code: String(issue.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80) || 'EDITORIAL_BLOCKER',
      severity,
      chapterIds: chapters.map(chapter => chapter.id),
      evidence,
      message,
      requiredFix
    }
  })
  if (invalidEvidence.length > 0) throw new ReleaseWindowEvidenceValidationError(invalidEvidence)
  const summary = [
    String(row.summary ?? '').trim(),
    droppedAdvisoryIssues.length > 0
      ? `已丢弃 ${droppedAdvisoryIssues.length} 条无法在正文中定位的建议性问题（序号：${droppedAdvisoryIssues.join('、')}）`
      : ''
  ].filter(Boolean).join('；')
  return { scores, issues, summary }
}

function parseEvidenceCorrections(
  value: unknown,
  original: Record<string, unknown>,
  range: NovelReleaseWindowRange
): ParsedReleaseWindowReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('首发窗口证据纠正根节点不是对象')
  }
  const corrections = (value as Record<string, unknown>).corrections
  if (!Array.isArray(corrections) || corrections.length === 0) {
    throw new Error('首发窗口证据纠正缺少 corrections')
  }
  if (!Array.isArray(original.issues)) throw new Error('原始首发窗口审读缺少 issues')
  const issues = original.issues.map(issue => (
    issue && typeof issue === 'object' && !Array.isArray(issue) ? { ...issue } : issue
  )) as unknown[]
  for (const correction of corrections) {
    if (!correction || typeof correction !== 'object' || Array.isArray(correction)) {
      throw new Error('首发窗口证据纠正项不是对象')
    }
    const item = correction as Record<string, unknown>
    const issueIndex = Number(item.issueIndex)
    const evidence = Array.isArray(item.evidence)
      ? item.evidence.map(String).map(text => text.trim()).filter(Boolean)
      : []
    if (!Number.isInteger(issueIndex) || issueIndex < 1 || issueIndex > issues.length || evidence.length === 0) {
      throw new Error('首发窗口证据纠正项索引或证据无效')
    }
    const issue = issues[issueIndex - 1]
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
      throw new Error(`首发窗口问题 ${issueIndex} 不可纠正`)
    }
    issues[issueIndex - 1] = { ...(issue as Record<string, unknown>), evidence }
  }
  return parseReleaseWindowReview({ ...original, issues }, range)
}

async function correctReleaseWindowEvidence(input: {
  workId: number
  range: NovelReleaseWindowRange
  original: Record<string, unknown>
  error: ReleaseWindowEvidenceValidationError
  goal: string
  signal?: AbortSignal
}): Promise<ParsedReleaseWindowReview> {
  const correction = await requestStructuredModelOutput<Record<string, unknown>>({
    workId: input.workId,
    label: `小说首发窗口 ${input.range.startIndex}-${input.range.endIndex} 章证据纠正`,
    attempts: 2,
    signal: input.signal,
    schema: RELEASE_WINDOW_EVIDENCE_CORRECTION_SCHEMA,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(input.workId, {
        workId: input.workId,
        step: 'goal_novel_release_window_audit',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        thinkingEnabled: false,
        forceThinkingDisabled: true,
        maxTokens: attempt === 1 ? 3000 : 5000,
        responseSchema: {
          name: 'novel_release_window_evidence_correction',
          schema: RELEASE_WINDOW_EVIDENCE_CORRECTION_SCHEMA,
          strict: true
        },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是首发审读证据校正器，只修正 evidence，不得修改评分、问题、结论或章节范围。',
          '每条 evidence 必须从声明章节正文中逐字连续复制；禁止同义改写、补写、拼接或省略号。',
          '只返回 corrections JSON；issueIndex 使用原审读问题序号。'
        ].join('\n'),
        prompt: [
          `【创作目标】\n${input.goal.trim() || '完成可持续连载的长篇小说'}`,
          `【原审读问题】\n${JSON.stringify(input.error.invalidIssues, null, 2)}`,
          `【需要保持不变的原审读 JSON】\n${JSON.stringify(input.original, null, 2)}`,
          `【声明章节正文】\n${input.error.invalidIssues.flatMap(issue => issue.chapterTitles).map(title => {
            const chapter = input.range.chapters.find(item => item.title === title)
            return chapter ? `## ${title}\n${chapter.content?.trim() ?? ''}` : ''
          }).filter(Boolean).join('\n\n')}`,
          lastError ? `【上次协议错误】\n${lastError}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal: input.signal }
    ),
    validate: value => value
  })
  return parseEvidenceCorrections(correction, input.original, input.range)
}

export function resolvePendingNovelReleaseWindow(workId: number): NovelReleaseWindowRange | null {
  const windows = planCompletedNovelReleaseWindows(volumeChapterDAO.listChaptersByWork(workId))
  return windows.find(window => !novelReleaseWindowDAO.findPassed(
    workId,
    window.startIndex,
    window.endIndex,
    window.sourceHash
  )) ?? null
}

function deterministicWindowIssues(
  workId: number,
  range: NovelReleaseWindowRange
): NovelReleaseWindowIssueInput[] {
  const chapterIds = new Set(range.chapters.map(chapter => chapter.id))
  const allChapters = volumeChapterDAO.listChaptersByWork(workId)
  const windowChapters = allChapters.filter(chapter => chapterIds.has(chapter.id))
  const facts = storyStateDAO.listFactsByWork(workId).filter(fact => chapterIds.has(fact.chapter_id))
  const fingerprints = storyStateDAO.listFingerprintsByWork(workId).filter(row => chapterIds.has(row.chapter_id))
  const systemic = [
    ...detectStoryStateIssues(facts),
    ...detectChapterPatternIssues(windowChapters, fingerprints, {
      requireFingerprints: true,
      includeProseScan: true
    })
  ]
  const issues: NovelReleaseWindowIssueInput[] = systemic.map(issue => ({
    code: issue.code,
    severity: issue.severity === 'blocker' ? 'blocker' : 'warning',
    chapterIds: issue.chapterIds,
    evidence: issue.evidence,
    message: issue.message,
    requiredFix: issue.recommendedAction
  }))
  for (const chapter of windowChapters) {
    if (chapter.status !== 'completed') {
      issues.push({
        code: 'CHAPTER_NOT_COMMITTED', severity: 'blocker', chapterIds: [chapter.id],
        evidence: [`${chapter.title} status=${chapter.status}`],
        message: '首发窗口包含未原子提交章节', requiredFix: '完成章级权威状态事务后重新审读'
      })
    }
    try {
      causalNovelDAO.assertCommittedBindingCurrent(workId, chapter.id)
    } catch (error) {
      issues.push({
        code: 'STALE_CHAPTER_BINDING', severity: 'blocker', chapterIds: [chapter.id],
        evidence: [error instanceof Error ? error.message : String(error)],
        message: '正文与权威因果状态绑定不一致', requiredFix: '重新生成并原子提交当前正文对应的章级状态'
      })
    }
    const resource = runResourceConstraintGate(workId, chapter.id)
    if (resource.blockers.length > 0) {
      issues.push({
        code: 'RESOURCE_LEDGER_UNBALANCED', severity: 'blocker', chapterIds: [chapter.id],
        evidence: resource.blockers, message: '章节资源账本不平', requiredFix: '补齐开章、变化和章末资源预算并重新提交'
      })
    }
  }
  return issues
}

async function reviewWindowProse(
  workId: number,
  range: NovelReleaseWindowRange,
  goal: string,
  signal?: AbortSignal
): Promise<ParsedReleaseWindowReview> {
  return requestStructuredModelOutput<ParsedReleaseWindowReview>({
    workId,
    label: `小说首发窗口 ${range.startIndex}-${range.endIndex} 章独立编辑审读`,
    attempts: 2,
    signal,
    schema: RELEASE_WINDOW_SCHEMA,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_novel_release_window_audit',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0.2,
        // 审读的推理价值必须落在可校验 JSON 中；隐藏 reasoning 与 JSON
        // 共用 completion 上限时，模型可能耗尽额度却返回空正文。
        thinkingEnabled: false,
        forceThinkingDisabled: true,
        maxTokens: attempt === 1 ? 8000 : 12000,
        responseSchema: {
          name: 'novel_release_window_audit',
          schema: RELEASE_WINDOW_SCHEMA,
          strict: true
        },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是长篇网文首发包独立主编，只审读，不改写正文。完整阅读输入的连续八章，不得抽样。',
          '连续性、物品生命周期、人物身份、地点、知识状态和资源守恒属于硬事实；综合高分不能抵消硬伤。',
          '检查第一章立钩子、第二章扩大承诺、第三章首次兑现，以及八章内目标、阻力、代价、关系和追读问题是否持续升级。',
          'scores 每项必须独立评分；issues 只写有逐字原文证据的问题。blocker 表示不修不能发布，warning 表示建议。',
          '每条 evidence 必须是声明章节中一段连续原文，不得概括、拼接或使用省略号。',
          '低分维度必须至少有一项可定位 issue；没有证据不得任意压低分数。',
          '只输出约定 JSON。'
        ].join('\n'),
        prompt: [
          `【创作目标】\n${goal.trim() || '完成可持续连载的长篇小说'}`,
          `【窗口正文哈希】${range.sourceHash}`,
          `【连续正文】\n${range.chapters.map((chapter, index) => (
            `## 第${range.startIndex + index}章数据库标题：${chapter.title}\n${chapter.content?.trim() ?? ''}`
          )).join('\n\n')}`,
          lastError ? `【上次协议错误】\n${lastError}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    ),
    shouldRepairValidationError: error => error instanceof ReleaseWindowEvidenceValidationError,
    repairValidationError: ({ value, error }) => correctReleaseWindowEvidence({
      workId,
      range,
      original: value,
      error: error as ReleaseWindowEvidenceValidationError,
      goal,
      signal
    }),
    validate: value => parseReleaseWindowReview(value, range)
  })
}

export async function auditPendingNovelReleaseWindow(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<NovelReleaseWindowAuditResult | null> {
  const range = resolvePendingNovelReleaseWindow(workId)
  if (!range) return null
  const authorityRevision = causalNovelDAO.getState(workId)?.revision ?? 0
  const auditId = novelReleaseWindowDAO.start({
    workId,
    startChapterId: range.startChapterId,
    endChapterId: range.endChapterId,
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    sourceHash: range.sourceHash,
    authorityRevision,
    protocolVersion: NOVEL_RELEASE_WINDOW_PROTOCOL_VERSION
  })
  onProgress?.(`正在全量审读第 ${range.startIndex}-${range.endIndex} 章首发窗口`)
  const deterministic = deterministicWindowIssues(workId, range)
  let editorial: ParsedReleaseWindowReview
  try {
    editorial = await reviewWindowProse(workId, range, goal, signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    novelReleaseWindowDAO.finish({
      auditId,
      status: 'blocked',
      overallScore: 0,
      scores: {},
      blockers: [`EDITORIAL_EVALUATOR_FAILED：${message}`],
      summary: '首发窗口独立编辑审读失败，未产生发布结论',
      issues: [{
        code: 'EDITORIAL_EVALUATOR_FAILED',
        severity: 'blocker',
        chapterIds: range.chapters.map(chapter => chapter.id),
        evidence: [message],
        message: '独立编辑审读未完成，禁止沿用旧分数或继续生成',
        requiredFix: '恢复审读模型后对同一正文哈希重新执行完整八章审读'
      }]
    })
    throw error
  }
  const score = calculateNovelReleaseScore(editorial.scores)
  const scoreBlockers = novelReleaseScoreBlockers(score)
  const issues = [...deterministic, ...editorial.issues]
  const issueBlockers = issues.filter(issue => issue.severity === 'blocker')
    .map(issue => `${issue.code}：${issue.message}`)
  if (scoreBlockers.length > 0 && editorial.issues.every(issue => issue.severity !== 'blocker')) {
    issues.push({
      code: 'SCORE_EVIDENCE_MISSING', severity: 'blocker',
      chapterIds: range.chapters.map(chapter => chapter.id),
      evidence: Object.entries(score).map(([key, value]) => `${key}=${value}`),
      message: '评估分数未达发布线，但评估器没有提供可定位的阻塞证据',
      requiredFix: '冻结正文并重新执行独立编辑审读；禁止根据无证据低分自动改写'
    })
    issueBlockers.push('SCORE_EVIDENCE_MISSING：低分缺少正文证据')
  }
  const blockers = [...new Set([...issueBlockers, ...scoreBlockers])]
  const passed = blockers.length === 0
  const summary = `${editorial.summary || '首发窗口审读完成'}；综合分 ${score.overall}`
  const snapshotId = novelReleaseWindowDAO.finish({
    auditId,
    status: passed ? 'passed' : 'blocked',
    overallScore: score.overall,
    scores: score,
    blockers,
    summary,
    issues
  })
  if (passed) {
    for (const chapter of range.chapters) {
      clearChapterEditorialDebt({ workId, chapterId: chapter.id, kinds: ['quality', 'emotion', 'style'] })
    }
  }
  return { auditId, snapshotId, range, passed, score, blockers, summary, issues }
}
