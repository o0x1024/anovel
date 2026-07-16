import { coreSettingDAO, workDAO } from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import { appLogger } from '../../logger/app-logger'
import { parseJsonObjectWithRepairs } from '../../../shared/model-json-repair'
import { withGoalLoopModelOptions } from './story-goal-model'
import { formatGenrePolicy, resolveStoryGenrePolicy } from './story-genre-policy'
import { auditStoryEngineSemantics } from './story-engine-semantic-audit'
import { GoalPhaseExhaustedError } from './goal-phase-error'
import { deriveRequiredStorySettingResolutions } from '../../../shared/story-harness'

const STORY_ENGINE_MAX_ROUNDS = 3
const STORY_ENGINE_FORMAT_ATTEMPTS = 2
const STORY_ENGINE_MAX_TOKENS = 4200

const STORY_ENGINE_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'score', 'blocking_issues', 'engine'],
  properties: {
    passed: { type: 'boolean' },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    blocking_issues: {
      type: 'array', maxItems: 6,
      items: { type: 'string', maxLength: 180 }
    },
    engine: {
      type: 'object',
      additionalProperties: false,
      required: [
        'genre_mode', 'protagonist_desire', 'inner_need', 'opponent_desire',
        'central_dilemma', 'ability_boundary_and_cost', 'causal_escalation',
        'midpoint_choice_and_cost', 'climax_choice_and_cost',
        'ending_change_and_aftertaste', 'fair_clues_and_payoffs',
        'setting_resolutions'
      ],
      properties: {
        genre_mode: { type: 'string', maxLength: 100 },
        protagonist_desire: { type: 'string', maxLength: 180 },
        inner_need: { type: 'string', maxLength: 180 },
        opponent_desire: { type: 'string', maxLength: 180 },
        central_dilemma: { type: 'string', maxLength: 240 },
        ability_boundary_and_cost: { type: 'string', maxLength: 240 },
        causal_escalation: {
          type: 'array', minItems: 3, maxItems: 5,
          items: { type: 'string', maxLength: 180 }
        },
        midpoint_choice_and_cost: { type: 'string', maxLength: 240 },
        climax_choice_and_cost: { type: 'string', maxLength: 240 },
        ending_change_and_aftertaste: { type: 'string', maxLength: 240 },
        fair_clues_and_payoffs: {
          type: 'array', minItems: 2, maxItems: 6,
          items: { type: 'string', maxLength: 180 }
        },
        setting_resolutions: {
          type: 'array', maxItems: 6,
          items: { type: 'string', maxLength: 240 }
        }
      }
    }
  }
}

interface EngineGatePayload {
  passed: boolean
  score: number
  blockingIssues: string[]
  engine: Record<string, unknown>
  formatRepairs: string[]
}

function parsePayload(content: string): EngineGatePayload {
  const json = extractJsonText(content.trim()) ?? content.trim()
  const parsed = parseJsonObjectWithRepairs<Record<string, unknown>>(json, {
    arrayBeforeProperties: [
      'midpoint_choice_and_cost', 'climax_choice_and_cost',
      'ending_change_and_aftertaste', 'fair_clues_and_payoffs'
    ]
  })
  const row = parsed.value
  if (typeof row.passed !== 'boolean' || !row.engine || typeof row.engine !== 'object' || Array.isArray(row.engine)) {
    throw new Error('故事发动机门禁返回结构无效')
  }
  if (!Array.isArray(row.blocking_issues) || !Number.isFinite(Number(row.score))) {
    throw new Error('故事发动机门禁缺少 score 或 blocking_issues')
  }
  const engine = row.engine as Record<string, unknown>
  const scalarFields = [
    'genre_mode', 'protagonist_desire', 'inner_need', 'opponent_desire',
    'central_dilemma', 'ability_boundary_and_cost', 'midpoint_choice_and_cost',
    'climax_choice_and_cost', 'ending_change_and_aftertaste'
  ]
  const missingScalars = scalarFields.filter(field => typeof engine[field] !== 'string' || !String(engine[field]).trim())
  const invalidArrays = ['causal_escalation', 'fair_clues_and_payoffs']
    .filter(field => !Array.isArray(engine[field]) || (engine[field] as unknown[]).length === 0)
  if (!Array.isArray(engine.setting_resolutions)) invalidArrays.push('setting_resolutions')
  if (missingScalars.length > 0 || invalidArrays.length > 0) {
    throw new Error(`故事发动机字段不完整：${[...missingScalars, ...invalidArrays].join('、')}`)
  }
  const score = Math.max(0, Math.min(100, Math.round(Number(row.score) || 0)))
  const blockingIssues = Array.isArray(row.blocking_issues)
    ? row.blocking_issues.map(item => String(item).trim()).filter(Boolean)
    : []
  return {
    passed: row.passed && score >= 85 && blockingIssues.length === 0,
    score,
    blockingIssues,
    engine,
    formatRepairs: parsed.repairs
  }
}

async function requestEnginePayload(
  workId: number,
  request: {
    systemPrompt: string
    prompt: string
  },
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<EngineGatePayload> {
  let lastError = '未知格式错误'
  for (let attempt = 1; attempt <= STORY_ENGINE_FORMAT_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error('已取消')
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'story_engine_gate',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0.1,
        maxTokens: STORY_ENGINE_MAX_TOKENS,
        forceThinkingDisabled: true,
        responseSchema: {
          name: 'short_story_engine_gate',
          schema: STORY_ENGINE_RESPONSE_SCHEMA,
          strict: true
        },
        systemPrompt: request.systemPrompt,
        prompt: [
          request.prompt,
          attempt > 1
            ? `【格式重试】上一输出无效：${lastError}。压缩表述并重新输出完整 JSON；不得续写、解释或复制残缺片段。`
            : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) {
      lastError = response.error || '模型无返回'
    } else if (response.finishReason === 'length') {
      lastError = `输出达到 ${STORY_ENGINE_MAX_TOKENS} token 上限（finishReason=length）`
    } else {
      try {
        const parsed = parsePayload(response.content)
        if (parsed.formatRepairs.length > 0) {
          appLogger.warn('story_engine_gate', '故事发动机 JSON 已做确定性结构修复', {
            workId,
            attempt,
            repairs: parsed.formatRepairs
          })
          onProgress?.('故事发动机返回存在可证明的闭合符遗漏，已自动修复并继续门禁')
        }
        return parsed
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    appLogger.warn('story_engine_gate', '故事发动机结构化输出无效，局部重试', {
      workId,
      attempt,
      finishReason: response.finishReason,
      error: lastError
    })
    if (attempt < STORY_ENGINE_FORMAT_ATTEMPTS) {
      onProgress?.(`故事发动机结构化输出无效，正在本轮内部压缩重试（${attempt}/${STORY_ENGINE_FORMAT_ATTEMPTS}）`)
    }
  }
  throw new Error(`故事发动机结构化输出连续 ${STORY_ENGINE_FORMAT_ATTEMPTS} 次无效：${lastError}`)
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
  const requiredResolutions = deriveRequiredStorySettingResolutions(source)
  if (requiredResolutions.length > 0) {
    onProgress?.(`Harness 已冻结 ${requiredResolutions.length} 项设定消歧，后续不再由模型自由判定`)
  }

  let previous = ''
  let lastBlockingSummary = ''
  let round = 0
  while (round < STORY_ENGINE_MAX_ROUNDS) {
    round++
    if (signal?.aborted) throw new Error('已取消')
    onProgress?.(`正在运行故事发动机门禁（第 ${round} 轮，达标前持续重建）`)
    const systemPrompt = [
      '你是短故事故事发动机主编。先从现有主线和设定提炼一个可执行故事发动机，再严格审查；不合格时直接重建发动机。',
      '发动机必须让胜负取决于人物选择，不能取决于巧合、反派自曝、无代价能力、突然出现的证据或权威认证。',
      '只输出符合给定 JSON Schema 的单个完整对象，不要 Markdown、解释或思考过程。',
      '压缩规则：因果升级写3至5项，公平伏笔写2至6项；每项只写一个“行动→反制/代价→状态变化”，不要扩写场景或正文。',
      'setting_resolutions 只记录对上游互斥设定的权威消歧；没有冲突时返回空数组。福利/财富冲突必须写清福利退出早于财富取得；竞赛亲属冲突必须同时写清亲属强制回避和独立机构认定成绩；倒计时冲突必须声明唯一数字。',
      '若输入含“Harness 冻结消歧”，它是程序已经裁决的事实合同。发动机全部字段必须服从，不得改写、弱化或生成相反口径；最终 setting_resolutions 将由程序覆盖为该合同。',
      '硬性通过条件：双方欲望明确；核心两难不可轻易绕过；能力有边界与代价；对手会合理反制；中点和高潮均由主角选择触发；结局保留损失或余味；所有关键解法均有前置依据。',
      formatGenrePolicy(policy, 'engineRules'),
      'score 低于85或存在任何 blocking_issues 时 passed 必须为 false。',
      `Schema：${JSON.stringify(STORY_ENGINE_RESPONSE_SCHEMA)}`
    ].join('\n\n')
    const prompt = [
      `【作品题材】${policy.label}`,
      `【创作目标】${goal.trim() || '高完读率、人物可信、因果完整的短故事'}`,
      `【现有主线与设定】\n${source}`,
      requiredResolutions.length > 0
        ? `【Harness 冻结消歧（权威且不可改写）】\n${requiredResolutions.join('\n')}`
        : '',
      structuralFeedback ? `【上一版正文暴露的结构问题】\n${structuralFeedback}` : '',
      previous ? `【上一轮发动机与门禁反馈，必须重建而非润色】\n${previous}` : ''
    ].filter(Boolean).join('\n\n')
    const result = await requestEnginePayload(workId, { systemPrompt, prompt }, signal, onProgress)
    if (requiredResolutions.length > 0) {
      // 模型只负责让发动机内容服从消歧，不再负责用自由文本证明它已消歧。
      result.engine.setting_resolutions = [...requiredResolutions]
    }
    if (result.passed) {
      const semanticIssues = await auditStoryEngineSemantics(workId, result.engine, signal)
      if (semanticIssues.length > 0) {
        lastBlockingSummary = semanticIssues
          .map(issue => `${issue.code}：${issue.message}；要求：${issue.expectedResult}`)
          .join('；')
        previous = JSON.stringify({
          engine: result.engine,
          blocking_issues: semanticIssues.map(issue => `${issue.code}：${issue.message}；修复结果：${issue.expectedResult}`)
        }, null, 2)
        onProgress?.(`故事发动机语义审计未通过（第 ${round} 轮）：${semanticIssues.map(issue => issue.code).join('、')}`)
        continue
      }
      coreSettingDAO.upsertStructured(
        workId,
        'story_engine',
        `# 故事发动机（${policy.label}）\n\n${JSON.stringify(result.engine, null, 2)}`,
        JSON.stringify({ genre_mode: policy.mode, score: result.score, ...result.engine })
      )
      // 新发动机是下游合同与情绪设计的事实源。只有新发动机通过后才清理
      // 旧派生设定，既避免候选失败时丢数据，也避免手动从本阶段启动后复用旧合同。
      coreSettingDAO.deleteByWorkAndTypes(workId, ['story_contract', 'emotion_engine'])
      onProgress?.(`故事发动机门禁通过（${result.score}分，第 ${round} 轮）`)
      return { score: result.score, rounds: round }
    }
    lastBlockingSummary = result.blockingIssues.join('；')
    previous = JSON.stringify({ engine: result.engine, blocking_issues: result.blockingIssues }, null, 2)
  }
  throw new GoalPhaseExhaustedError(
    `故事发动机连续 ${STORY_ENGINE_MAX_ROUNDS} 轮未通过，已停止自动重建并保留现有设定`
    + (lastBlockingSummary ? `；最后阻断：${lastBlockingSummary}` : '')
  )
}
