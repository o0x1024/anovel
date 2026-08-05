import { volumeChapterDAO } from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import { formatStoryContractForPrompt } from './story-contract'
import { withGoalLoopModelOptions } from './story-goal-model'
import { detectStoryMetaResidues, STORY_META_RESIDUE_RULES } from '../../../shared/story-hard-guards'
import { parseJsonObjectWithRepairs } from '../../../shared/model-json-repair'
import { requestQualityEvaluatorEvidence } from './quality-evaluator-policy'

export interface StoryContinuityGateResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
  evaluatorFailureCode?: 'QUALITY_EVALUATOR_UNAVAILABLE' | 'QUALITY_EVALUATOR_PROTOCOL'
}

const STORY_CONTINUITY_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['passed', 'blockers', 'warnings'],
  properties: {
    passed: { type: 'boolean' },
    blockers: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } }
  }
}

function list(value: unknown, limit = 12): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean).slice(0, limit)
    : []
}

function deterministicIssues(previous: string, current: string): string[] {
  const issues = STORY_META_RESIDUE_RULES.filter(([pattern]) => pattern.test(current)).map(([, label]) => label)
  if (!previous.trim()) return issues
  const previousLines = new Set(previous.split(/\n+/).map(line => line.trim()).filter(line => line.length >= 16))
  const repeated = current.split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length >= 16 && previousLines.has(line))
  if (repeated.length >= 2) issues.push(`与上一拍逐字重复 ${repeated.length} 行，疑似跨拍复述`)
  return issues
}

function sliceTail(text: string, length: number): string {
  return text.slice(Math.max(0, text.length - length))
}

export async function assessStoryBeatContinuity(
  workId: number,
  chapterId: number,
  candidate: string,
  signal?: AbortSignal
): Promise<StoryContinuityGateResult> {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const index = chapters.findIndex(chapter => chapter.id === chapterId)
  if (index < 0) return { passed: false, blockers: ['当前节拍不存在'], warnings: [] }
  const previous = index > 0 ? chapters[index - 1]?.content?.trim() ?? '' : ''
  const next = index < chapters.length - 1 ? chapters[index + 1]?.content?.trim() ?? '' : ''
  const deterministic = deterministicIssues(previous, candidate)
  if (deterministic.some(issue => /残留/.test(issue))) {
    return { passed: false, blockers: deterministic, warnings: [] }
  }

  const current = chapters[index]
  const isFinal = index === chapters.length - 1
  const evidence = await requestQualityEvaluatorEvidence<StoryContinuityGateResult>({
    workId,
    label: '跨拍连续性门禁',
    signal,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'story_continuity_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 1500,
      forceThinkingDisabled: true,
      responseSchema: { name: 'story_continuity_gate', schema: STORY_CONTINUITY_RESPONSE_SCHEMA, strict: true },
      structuredOutputMode: 'prompt_json',
      systemPrompt: [
        '你是短故事连续性法医。只判断候选正文能否安全接入整篇，不评价文采，不替作者脑补。',
        '下列任一情况必须 blocker：时间顺序冲突；地点或座位无过渡跳变；同一关键事件重复发生；证据/道具状态倒退；人物忘记已知信息；上一拍明确提出的阻碍被本拍无解法跳过；对手主动降智配合；高潮靠临时权威、巧合或新证据；正文出现生成提示。',
        '拍边界所有权：当前拍可以且应该完成到 continuity_contract.end_location/exit_facts，包括抵达下一拍开场地点、进入等待状态、收好下一拍开场已持有的道具；只有下一拍的首个不可逆事件不得提前发生。不得一边要求补足地点/道具过渡，一边又把完成该过渡判成越界。',
        '如果当前拍合同的 exit_facts 与已有下一拍开头本身互相矛盾，blocker 必须以“CONTRACT_UNSATISFIABLE：”开头并指出两端事实，不得把合同冲突归咎于候选正文。',
        isFinal
          ? '这是最终拍：必须回答故事合同的核心问题并回收 must_resolve；不得引入未经铺垫的新反派、新任务或续集主线。情绪余味可以保留，但主线必须结束。'
          : '这不是最终拍：结尾可以产生新问题，但必须由本拍因果自然产生。',
        'warnings 只放不致命的小瑕疵。只输出 JSON：{"passed":false,"blockers":["..."],"warnings":["..."]}'
      ].join('\n\n'),
      prompt: [
        formatStoryContractForPrompt(workId),
        `【当前节拍蓝图】\n${current.outline ?? ''}\n${current.outline_diagnosis ?? ''}`,
        previous ? `【上一拍结尾原文】\n${sliceTail(previous, 1800)}` : '【上一拍】无，这是第一拍',
        `【候选正文】\n${candidate}`,
        next ? `【已有下一拍开头，修订时不得与之冲突】\n${next.slice(0, 1800)}` : '',
        attempt > 1 ? `【上次取证协议错误】\n${lastError}` : ''
      ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    ),
    parse: content => {
      const json = extractJsonText(content.trim(), { allowEmptyArrays: true }) ?? content.trim()
      const parsed = parseJsonObjectWithRepairs<Record<string, unknown>>(json).value
      if (typeof parsed.passed !== 'boolean' || !Array.isArray(parsed.blockers) || !Array.isArray(parsed.warnings)) {
        throw new Error('跨拍连续性门禁返回协议缺少 passed、blockers 或 warnings')
      }
      const blockers = [...deterministic, ...list(parsed.blockers)]
      const warnings = list(parsed.warnings)
      return { passed: parsed.passed && blockers.length === 0, blockers, warnings }
    }
  })
  if (!evidence.success) {
    return {
      passed: false,
      blockers: [`${evidence.code}：${evidence.message}`],
      warnings: [],
      evaluatorFailureCode: evidence.code
    }
  }
  return evidence.value
}

export { detectStoryMetaResidues }
