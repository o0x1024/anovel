import { modelService } from '../../model'
import { volumeChapterDAO } from '../../db'
import { countWords } from '../../../shared/body-word-target'
import { extractJsonText } from '../parse-json-extract'
import { parseJsonObjectWithRepairs } from '../../../shared/model-json-repair'
import {
  formatChapterExecutionContract,
  type ChapterExecutionContract
} from '../../../shared/chapter-execution-contract'
import { withGoalLoopModelOptions } from './story-goal-model'

export type NovelCoverageVerdict = 'covered' | 'partial' | 'missing'

export interface NovelCoverageEvidence {
  event: string
  verdict: NovelCoverageVerdict
  evidence: string
  reason: string
}

export interface NovelExecutionGateResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
  coverage: NovelCoverageEvidence[]
  forbiddenViolations: string[]
}

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['passed', 'coverage', 'forbidden_violations', 'continuity_blockers', 'warnings'],
  properties: {
    passed: { type: 'boolean' },
    coverage: {
      type: 'array',
      items: {
        type: 'object',
        required: ['event', 'verdict', 'evidence', 'reason'],
        properties: {
          event: { type: 'string' },
          verdict: { type: 'string', enum: ['covered', 'partial', 'missing'] },
          evidence: { type: 'string' },
          reason: { type: 'string' }
        }
      }
    },
    forbidden_violations: { type: 'array', items: { type: 'string' } },
    continuity_blockers: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } }
  }
}

function strings(value: unknown, limit = 20): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean).slice(0, limit)
    : []
}

function normalizeComparable(text: string): string {
  return text.replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】]/g, '')
}

function closestRequiredEvent(raw: string, required: string[]): string | null {
  const target = normalizeComparable(raw)
  if (!target) return null
  return required.find(item => normalizeComparable(item) === target)
    ?? required.find(item => {
      const normalized = normalizeComparable(item)
      return normalized.includes(target) || target.includes(normalized)
    })
    ?? null
}

export function validateNovelExecutionContract(contract: ChapterExecutionContract): string[] {
  const issues = [...contract.errors]
  if (contract.requiredEvents.length === 0) issues.push('没有可验收的必写情节节点')
  if (contract.scenes.length === 0) issues.push('没有可执行的场景清单')
  const owned = contract.scenes.flatMap(scene => scene.mustCover)
  for (const event of contract.requiredEvents) {
    const count = owned.filter(item => normalizeComparable(item) === normalizeComparable(event)).length
    if (count !== 1) issues.push(`必写节点必须且只能归属一个场景：${event}`)
  }
  const allocated = contract.scenes.reduce((sum, scene) => sum + scene.targetWords, 0)
  if (contract.scenes.length > 0 && allocated !== contract.wordTarget) {
    issues.push(`场景字数预算合计 ${allocated}，与章节目标 ${contract.wordTarget} 不一致`)
  }
  return [...new Set(issues)]
}

export function parseNovelCoverageEvidence(
  value: unknown,
  contract: ChapterExecutionContract,
  content: string
): NovelCoverageEvidence[] {
  const rawRows = Array.isArray(value) ? value : []
  const byEvent = new Map<string, NovelCoverageEvidence>()
  for (const value of rawRows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    const event = closestRequiredEvent(String(row.event ?? ''), contract.requiredEvents)
    if (!event || byEvent.has(event)) continue
    const rawVerdict = String(row.verdict ?? '')
    let verdict: NovelCoverageVerdict = rawVerdict === 'covered' || rawVerdict === 'partial'
      ? rawVerdict
      : 'missing'
    const evidence = String(row.evidence ?? '').trim()
    let reason = String(row.reason ?? '').trim()
    if (verdict !== 'missing' && (!evidence || !content.includes(evidence))) {
      verdict = 'missing'
      reason = [reason, '评估器给出的证据不是正文精确原句'].filter(Boolean).join('；')
    }
    byEvent.set(event, { event, verdict, evidence: verdict === 'missing' ? '' : evidence, reason })
  }
  return contract.requiredEvents.map(event => byEvent.get(event) ?? {
    event,
    verdict: 'missing',
    evidence: '',
    reason: '评估器未返回该节点的覆盖证据'
  })
}

function previousChapterTail(workId: number, chapterId: number): string {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const index = chapters.findIndex(chapter => chapter.id === chapterId)
  if (index <= 0) return ''
  const content = chapters[index - 1]?.content?.trim() ?? ''
  return content.slice(Math.max(0, content.length - 1800))
}

export async function assessNovelExecutionCandidate(
  workId: number,
  chapterId: number,
  content: string,
  contract: ChapterExecutionContract,
  signal?: AbortSignal
): Promise<NovelExecutionGateResult> {
  const contractIssues = validateNovelExecutionContract(contract)
  if (contractIssues.length > 0) {
    return { passed: false, blockers: contractIssues, warnings: [], coverage: [], forbiddenViolations: [] }
  }
  const previous = previousChapterTail(workId, chapterId)
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'novel_execution_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 2200,
      forceThinkingDisabled: true,
      responseSchema: { name: 'novel_execution_gate', schema: RESPONSE_SCHEMA, strict: false },
      systemPrompt: [
        '你是长篇小说章节执行法医。只核验大纲事件覆盖、禁止越界和跨章状态，不评价文笔。',
        'coverage 必须与合同的每个必写事件一一对应。covered 必须给出候选正文中精确存在的连续原句；不能找到精确原句就判 missing。',
        'partial 表示事件出现但关键动作、阻力、选择或结果只被一句概括。missing 或 partial 都会阻止提交。',
        '以下情况必须 continuity_blockers：开头复述上一章；时间地点无过渡跳变；人物位置、伤势、资源或知情状态无来源变化；上一章未完成动作被跳过；结尾越过合同落点。',
        '不要按关键词机械匹配，要判断语义事件是否真实发生。只输出 JSON。'
      ].join('\n'),
      prompt: [
        formatChapterExecutionContract(contract),
        previous ? `【上一章最终正文尾部】\n${previous}` : '【上一章】无，这是第一章',
        `【候选正文，系统计数 ${countWords(content)} 字】\n${content}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    return {
      passed: false,
      blockers: [response.error || '章节执行门禁无返回'],
      warnings: [],
      coverage: [],
      forbiddenViolations: []
    }
  }
  try {
    const json = extractJsonText(response.content.trim()) ?? response.content.trim()
    const parsed = parseJsonObjectWithRepairs<Record<string, unknown>>(json).value
    const coverage = parseNovelCoverageEvidence(parsed.coverage, contract, content)
    const missing = coverage
      .filter(item => item.verdict !== 'covered')
      .map(item => `${item.verdict === 'partial' ? '情节仅部分落地' : '情节缺失'}：${item.event}${item.reason ? `（${item.reason}）` : ''}`)
    const forbiddenViolations = strings(parsed.forbidden_violations)
    const continuity = strings(parsed.continuity_blockers)
    const blockers = [...missing, ...forbiddenViolations.map(item => `提前越界：${item}`), ...continuity]
    return {
      passed: parsed.passed === true && blockers.length === 0,
      blockers: [...new Set(blockers)],
      warnings: strings(parsed.warnings),
      coverage,
      forbiddenViolations
    }
  } catch {
    return { passed: false, blockers: ['章节执行门禁返回格式无效'], warnings: [], coverage: [], forbiddenViolations: [] }
  }
}

export async function repairNovelExecutionCandidate(
  workId: number,
  chapterId: number,
  content: string,
  contract: ChapterExecutionContract,
  blockers: string[],
  signal?: AbortSignal
): Promise<{ success: boolean; content: string; error?: string }> {
  const previous = previousChapterTail(workId, chapterId)
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'novel_execution_repair',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.25,
      maxTokens: Math.max(6000, Math.min(12000, Math.ceil(countWords(content) * 2))),
      systemPrompt: [
        '你是长篇小说章节执行修复编辑。只输出修复后的完整正文，不要解释、标题或 Markdown。',
        '只修复门禁指出的遗漏、概括带过、提前越界和跨章断裂；保留已通过的事件、人物表达和文风。',
        '补写遗漏时必须融入原有因果顺序，不能把情节点作为说明句硬插入；删除越界内容后要让相邻段落自然接合。',
        '开头必须写上一章末尾之后发生的新结果，禁止复述上一章。结尾必须停在合同落点。'
      ].join('\n'),
      prompt: [
        formatChapterExecutionContract(contract),
        previous ? `【上一章最终正文尾部】\n${previous}` : '',
        `【必须修复的问题】\n${blockers.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
        `【待修复正文】\n${content}`
      ].filter(Boolean).join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    return { success: false, content, error: response.error || '章节执行定向修复失败' }
  }
  return { success: true, content: response.content.trim() }
}
