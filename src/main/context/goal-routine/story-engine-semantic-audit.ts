import { coreSettingDAO } from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import { parseJsonObjectWithRepairs } from '../../../shared/model-json-repair'
import {
  detectStorySettingContradictions,
  type StoryHarnessIssue,
  type StoryHarnessScope
} from '../../../shared/story-harness'
import { withGoalLoopModelOptions } from './story-goal-model'
import {
  requestQualityEvaluatorEvidence,
  requireQualityEvaluatorEvidence
} from './quality-evaluator-policy'

interface RawAuditIssue {
  code?: unknown
  evidence?: unknown
  message?: unknown
  expected_result?: unknown
}

const SOURCE_TYPES = [
  'idea', 'protagonist', 'golden_finger', 'pleasure_engine',
  'supporting_cast'
]

const SEMANTIC_AUDIT_FORMAT_ATTEMPTS = 2
const SEMANTIC_AUDIT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['blockers'],
  properties: {
    blockers: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'evidence', 'message', 'expected_result'],
        properties: {
          code: { type: 'string', maxLength: 80 },
          evidence: {
            type: 'array', minItems: 2, maxItems: 4,
            items: { type: 'string', maxLength: 180 }
          },
          message: { type: 'string', maxLength: 240 },
          expected_result: { type: 'string', maxLength: 240 }
        }
      }
    }
  }
}

export function storySemanticSource(workId: number, extra = ''): string {
  return [
    ...coreSettingDAO.listByWork(workId)
      .filter(setting => SOURCE_TYPES.includes(setting.type))
      .map(setting => `## ${setting.type}\n${setting.content}`),
    extra
  ].filter(Boolean).join('\n\n')
}

function parseAuditIssues(content: string, scope: StoryHarnessScope): StoryHarnessIssue[] {
  const json = extractJsonText(content.trim(), { allowEmptyArrays: true }) ?? content.trim()
  const parsed = parseJsonObjectWithRepairs<{ blockers?: unknown }>(json).value
  if (!Array.isArray(parsed.blockers)) throw new Error('故事发动机窄问题审计缺少 blockers 数组')
  return parsed.blockers.map((raw): StoryHarnessIssue | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const row = raw as RawAuditIssue
    const message = String(row.message ?? '').trim()
    if (!message) return null
    return {
      code: String(row.code ?? 'ENGINE_SEMANTIC_CONFLICT').trim() || 'ENGINE_SEMANTIC_CONFLICT',
      severity: 'blocker',
      scope,
      evidence: Array.isArray(row.evidence)
        ? row.evidence.map(String).map(value => value.trim()).filter(Boolean).slice(0, 4)
        : [],
      message,
      expectedResult: String(row.expected_result ?? '重建故事发动机并消除矛盾').trim()
    }
  }).filter((value): value is StoryHarnessIssue => value != null)
}

async function runNarrowAudit(
  workId: number,
  source: string,
  question: string,
  signal?: AbortSignal
): Promise<StoryHarnessIssue[]> {
  const result = await requestQualityEvaluatorEvidence<StoryHarnessIssue[]>({
    workId,
    label: '故事发动机窄问题审计',
    attempts: SEMANTIC_AUDIT_FORMAT_ATTEMPTS,
    signal,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'story_engine_semantic_audit',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens: 1200,
        forceThinkingDisabled: true,
        responseSchema: {
          name: 'short_story_engine_semantic_audit',
          schema: SEMANTIC_AUDIT_RESPONSE_SCHEMA,
          strict: true
        },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是短故事发动机的单问题审计器。只审查指定问题，不评分、不润色、不扩写。',
          'candidate_engine.setting_resolutions 是 Harness 已裁决的权威口径；审计时用它覆盖上游互斥或含糊表述，不得把已被覆盖的旧说法再次报为冲突。',
          '只报告能引用输入原文证明、足以让故事核心因果不成立的硬冲突。题材夸张但内部自洽不算硬伤。',
          '每个问题必须给出两端冲突证据；没有硬冲突返回空数组。',
          '只输出符合给定 JSON Schema 的单个完整对象，不要 Markdown、解释或思考过程。',
          `Schema：${JSON.stringify(SEMANTIC_AUDIT_RESPONSE_SCHEMA)}`
        ].join('\n'),
        prompt: [
          `【本次唯一审计问题】\n${question}\n\n【故事设定与发动机】\n${source.slice(0, 18_000)}`,
          attempt > 1
            ? `【格式重试】上一输出无效：${lastError}。重新输出完整且更短的 JSON，不得续写残缺片段。`
            : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    ),
    parse: content => parseAuditIssues(content, 'engine')
  })
  return requireQualityEvaluatorEvidence(result, '故事发动机窄问题审计')
}

/**
 * 弱模型友好：确定性检查优先，再拆成两个互不干扰的窄问题审计。
 * 不让同一次调用同时完成写作、自评和修复。
 */
export async function auditStoryEngineSemantics(
  workId: number,
  engine: Record<string, unknown>,
  signal?: AbortSignal
): Promise<StoryHarnessIssue[]> {
  const baseSource = storySemanticSource(workId)
  const resolutionSource = Array.isArray(engine.setting_resolutions)
    ? engine.setting_resolutions.map(String).join('\n')
    : ''
  const deterministic = detectStorySettingContradictions(baseSource, resolutionSource)
  if (deterministic.length > 0) return deterministic
  const source = [baseSource, `## candidate_engine\n${JSON.stringify(engine, null, 2)}`].join('\n\n')

  const questions = [
    '人物合法性与资源因果：贫困、福利、财富、家庭救命资源、身份隐瞒能否同时成立？主角的胜利是否存在亲属评审或权力利益冲突？',
    '时间、制度与高潮：年龄年级、过去事件、倒计时、对手权限、证据来源和官方处置能否按唯一因果链成立？高潮是否依赖反派自曝、临时权威或未铺垫证据？'
  ]
  const issues: StoryHarnessIssue[] = []
  for (const question of questions) {
    if (signal?.aborted) throw new Error('已取消')
    issues.push(...await runNarrowAudit(workId, source, question, signal))
  }
  const unique = new Map(issues.map(value => [`${value.code}:${value.message}`, value]))
  return [...unique.values()]
}
