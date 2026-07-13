import { coreSettingDAO, workDAO } from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import { withGoalLoopModelOptions } from './story-goal-model'
import { formatGenrePolicy, resolveStoryGenrePolicy } from './story-genre-policy'

interface EngineGatePayload {
  passed: boolean
  score: number
  blockingIssues: string[]
  engine: Record<string, unknown>
}

function parsePayload(content: string): EngineGatePayload {
  const json = extractJsonText(content.trim()) ?? content.trim()
  const row = JSON.parse(json) as Record<string, unknown>
  if (typeof row.passed !== 'boolean' || !row.engine || typeof row.engine !== 'object' || Array.isArray(row.engine)) {
    throw new Error('故事发动机门禁返回结构无效')
  }
  const score = Math.max(0, Math.min(100, Math.round(Number(row.score) || 0)))
  const blockingIssues = Array.isArray(row.blocking_issues)
    ? row.blocking_issues.map(item => String(item).trim()).filter(Boolean)
    : []
  return { passed: row.passed && score >= 85 && blockingIssues.length === 0, score, blockingIssues, engine: row.engine as Record<string, unknown> }
}

function sourceContext(workId: number): string {
  return coreSettingDAO.listByWork(workId)
    .filter(setting => ['idea', 'protagonist', 'golden_finger', 'pleasure_engine', 'supporting_cast'].includes(setting.type))
    .map(setting => `## ${setting.type}\n${setting.content}`)
    .join('\n\n')
}

export async function ensureStoryEngine(
  workId: number,
  goal: string,
  structuralFeedback = '',
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ score: number; rounds: number }> {
  const work = workDAO.getById(workId)
  const genreText = [work?.genre, work?.tags, goal].filter(Boolean).join('\n')
  const policy = resolveStoryGenrePolicy(genreText)
  const source = sourceContext(workId)
  if (!source.trim()) throw new Error('故事发动机门禁缺少主线与核心设定')

  let previous = ''
  let round = 0
  while (true) {
    round++
    if (signal?.aborted) throw new Error('已取消')
    onProgress?.(`正在运行故事发动机门禁（第 ${round} 轮，达标前持续重建）`)
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'story_engine_gate',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0.15,
        maxTokens: 2600,
        systemPrompt: [
          '你是短故事故事发动机主编。先从现有主线和设定提炼一个可执行故事发动机，再严格审查；不合格时直接重建发动机。',
          '发动机必须让胜负取决于人物选择，不能取决于巧合、反派自曝、无代价能力、突然出现的证据或权威认证。',
          '只输出 JSON：{"passed":false,"score":70,"blocking_issues":["..."],"engine":{"genre_mode":"...","protagonist_desire":"...","inner_need":"...","opponent_desire":"...","central_dilemma":"...","ability_boundary_and_cost":"...","causal_escalation":["..."],"midpoint_choice_and_cost":"...","climax_choice_and_cost":"...","ending_change_and_aftertaste":"...","fair_clues_and_payoffs":["..."]}}',
          '硬性通过条件：双方欲望明确；核心两难不可轻易绕过；能力有边界与代价；对手会合理反制；中点和高潮均由主角选择触发；结局保留损失或余味；所有关键解法均有前置依据。',
          formatGenrePolicy(policy, 'engineRules'),
          'score 低于85或存在任何 blocking_issues 时 passed 必须为 false。'
        ].join('\n\n'),
        prompt: [
          `【作品题材】${policy.label}`,
          `【创作目标】${goal.trim() || '高完读率、人物可信、因果完整的短故事'}`,
          `【现有主线与设定】\n${source}`,
          structuralFeedback ? `【上一版正文暴露的结构问题】\n${structuralFeedback}` : '',
          previous ? `【上一轮发动机与门禁反馈，必须重建而非润色】\n${previous}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) throw new Error(response.error || '故事发动机门禁无返回')
    const result = parsePayload(response.content)
    if (result.passed) {
      coreSettingDAO.upsertStructured(
        workId,
        'story_engine',
        `# 故事发动机（${policy.label}）\n\n${JSON.stringify(result.engine, null, 2)}`,
        JSON.stringify({ genre_mode: policy.mode, score: result.score, ...result.engine })
      )
      onProgress?.(`故事发动机门禁通过（${result.score}分，第 ${round} 轮）`)
      return { score: result.score, rounds: round }
    }
    previous = JSON.stringify({ engine: result.engine, blocking_issues: result.blockingIssues }, null, 2)
  }
}
