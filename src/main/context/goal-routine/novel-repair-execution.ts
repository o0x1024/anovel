import { createHash } from 'node:crypto'
import { getDatabase } from '../../db/connection'
import {
  causalNovelDAO,
  novelChapterAcceptanceDAO,
  resourceLedgerDAO,
  volumeChapterDAO,
  type NovelChapterGateType
} from '../../db'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { modelService } from '../../model'
import { clearChapterNarrativeMemory } from '../memory-cleanup'
import { extractJsonText } from '../parse-json-extract'
import { runConsistencyGate } from '../consistency-gate'
import { emotionRepairHint } from './emotion-gate'
import {
  NovelPipelineError,
  readNovelGoalState,
  updateNovelGoalState
} from './novel-outline-pipeline'
import { assertNovelGoalNotAborted as assertNotAborted } from './novel-runtime-utils'
import {
  runChapterConvergenceGate,
  strictChapterTransitionBlockers
} from './novel-chapter-acceptance'
import {
  getNovelChapterAcceptanceSummary,
  resolveNovelChapterAcceptanceIdentity
} from './novel-chapter-acceptance-ledger'
import type { RepairPlan } from './novel-repair-plan'
import {
  ensureUnifiedNovelDecision,
  prepareUnifiedNovelChapterCommit
} from './unified-novel-chapter'
import {
  assertUnifiedStructuralRepairAllowed,
  captureUnifiedNovelRepair,
  commitUnifiedNovelRepair,
  discardUnifiedNovelRepairCandidate,
  discardUnifiedPlannedDecisions
} from './unified-novel-repair'
import { generateBeatBody, reviseBeatBody } from './story-goal-doer'
import type { StoryGoalConfig } from './story-goal-checker'
import {
  getGoalLoopModelOpts,
  withGoalLoopModelOptions
} from './story-goal-model'
import type { UnifiedNovelRepairContext } from './unified-novel-repair'
import { classifyWordRangeRepairAction } from './novel-autonomous-control'
import {
  compileChapterExecutionContract,
  persistChapterExecutionContract
} from '../chapter-execution-context'
import { reserveChapterTransactionPatch } from './novel-chapter-transaction-policy'
import { validatePromptJsonSchema } from '../../../shared/prompt-json-schema-validator'
import { countWords } from '../../../shared/body-word-target'
import type { ChapterResourceBudgetInput } from '../../db/dao/resource-ledger-dao'
import { validateResourceBudgets } from './novel-volume-chapter-gate'

const STRUCTURAL_DRAMATIC_CONTRACT_FIELDS = [
  'scene_promise',
  'protagonist_want',
  'obstacle',
  'stakes',
  'info_gap',
  'pressure_escalation',
  'turn',
  'irreversible_change',
  'payoff_or_debt',
  'next_question'
] as const

const STRUCTURAL_PATTERN_CONTRACT_FIELDS = [
  'conflict_type',
  'protagonist_method',
  'antagonist_tactic',
  'anticipated_opponent_adjustment',
  'location_type',
  'hook_type',
  'cost_type',
  'relationship_delta',
  'volume_objective_delta'
] as const

function stringObjectSchema(fields: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...fields],
    properties: Object.fromEntries(fields.map(field => [field, {
      type: 'string',
      minLength: 1
    }]))
  }
}

function structuralRepairResponseSchema(targetChapterIds: number[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['chapters'],
    properties: {
      chapters: {
        type: 'array',
        minItems: targetChapterIds.length,
        maxItems: targetChapterIds.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'outline',
            'next_hook',
            'dramatic_contract',
            'pattern_contract',
            'tension_plan',
            'resource_budget'
          ],
          properties: {
            id: { type: 'integer', enum: targetChapterIds },
            outline: { type: 'string', minLength: 1 },
            next_hook: { type: 'string', minLength: 1 },
            dramatic_contract: stringObjectSchema(STRUCTURAL_DRAMATIC_CONTRACT_FIELDS),
            pattern_contract: stringObjectSchema(STRUCTURAL_PATTERN_CONTRACT_FIELDS),
            tension_plan: {
              type: 'object',
              additionalProperties: false,
              required: ['level', 'payoff_type'],
              properties: {
                level: { type: 'integer', minimum: 1, maximum: 10 },
                payoff_type: {
                  type: 'string',
                  enum: ['debt', 'partial', 'major', 'aftertaste']
                }
              }
            },
            resource_budget: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'owner', 'resource', 'unit', 'start_min', 'start_max', 'end_min', 'end_max',
                  'allowed_events', 'forbidden_events', 'reason'
                ],
                properties: {
                  owner: { type: ['string', 'null'] },
                  resource: { type: 'string', minLength: 1 },
                  unit: { type: ['string', 'null'] },
                  start_min: { type: ['number', 'null'] },
                  start_max: { type: ['number', 'null'] },
                  end_min: { type: ['number', 'null'] },
                  end_max: { type: ['number', 'null'] },
                  allowed_events: { type: ['string', 'null'] },
                  forbidden_events: { type: ['string', 'null'] },
                  reason: { type: ['string', 'null'] }
                }
              }
            }
          }
        }
      }
    }
  }
}

function gateFailureCode(gateType: NovelChapterGateType | undefined): NovelPipelineError['code'] {
  if (gateType === 'emotion') return 'EMOTION_NON_CONVERGENT'
  if (gateType === 'execution_contract') return 'EXECUTION_CONTRACT_NON_CONVERGENT'
  return 'QUALITY_NON_CONVERGENT'
}

export class NovelRepairGateError extends NovelPipelineError {
  constructor(
    readonly chapterId: number,
    readonly blockedGate: NovelChapterGateType | undefined,
    readonly failedMetrics: string[],
    message: string
  ) {
    super(gateFailureCode(blockedGate), message)
    this.name = 'NovelRepairGateError'
  }
}

export class NovelRepairRevalidationRequiredError extends Error {
  readonly code = 'BODY_REVALIDATION_REQUIRED'

  constructor(readonly chapterId: number) {
    super('因果正文合同补丁已产生新正文版本，必须重新执行章节联合门禁')
    this.name = 'NovelRepairRevalidationRequiredError'
  }
}

/**
 * 正文修订是以已有正文为输入的变换，不是生成器。
 * 结构重规划会有意废弃旧正文；此时必须回到正文生成状态机，不能把空输入
 * 伪装成一次执行合同修订，否则验收只会重复报告“最终正文为空”。
 */
export class NovelRepairGenerationRequiredError extends NovelPipelineError {
  constructor(readonly chapterId: number, readonly chapterTitle: string) {
    super(
      'EMPTY_BODY_REGENERATION_REQUIRED',
      `「${chapterTitle}」没有可修订正文，必须按当前冻结合同重新生成`
    )
    this.name = 'NovelRepairGenerationRequiredError'
  }
}

function assertGeneratedRepair(
  result: Awaited<ReturnType<typeof reviseBeatBody>>
): asserts result is Awaited<ReturnType<typeof reviseBeatBody>> & { success: true } {
  if (result.success) return
  throw new Error(result.error || '章节修订失败')
}

function repairGateError(
  chapterId: number,
  chapterTitle: string,
  result: {
    blockedGate?: NovelChapterGateType
    failedMetrics: string[]
  }
): NovelRepairGateError {
  return new NovelRepairGateError(
    chapterId,
    result.blockedGate,
    result.failedMetrics,
    `「${chapterTitle}」修订候选未通过 ${result.blockedGate ?? 'quality'} 门禁：`
      + result.failedMetrics.join('、')
  )
}

function bodyHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function settleRejectedRepairCandidate(context: UnifiedNovelRepairContext): void {
  if (context.decisionStatus === 'committed') {
    discardUnifiedNovelRepairCandidate(context)
    return
  }
  // Planned chapters have no published causal authority. Keep the locally
  // valid working body so the next orthogonal gate repairs this candidate
  // instead of restarting from the stale source draft.
  volumeChapterDAO.updateChapter(context.chapterId, { status: 'draft' })
}

function restoreWordCompliantPlannedCandidate(input: {
  workId: number
  chapterId: number
  config: StoryGoalConfig
}): boolean {
  const decision = causalNovelDAO.getDecision(input.chapterId)
  const chapter = volumeChapterDAO.getChapter(input.chapterId)
  const contract = compileChapterExecutionContract(input.workId, input.chapterId)
  if (!decision || decision.status !== 'planned' || !chapter || !contract) return false
  const currentContent = chapter.content?.trim() ?? ''
  const currentWords = countWords(currentContent)
  if (currentWords >= contract.wordMin && currentWords <= contract.wordMax) return false
  const identity = resolveNovelChapterAcceptanceIdentity(
    input.workId,
    input.chapterId,
    input.config
  )
  const candidate = novelChapterAcceptanceDAO.findLatestWordCompliantCandidate({
    workId: input.workId,
    chapterId: input.chapterId,
    contractHash: identity.contractHash,
    protocolVersion: identity.protocolVersion,
    minWords: contract.wordMin,
    maxWords: contract.wordMax,
    excludeContentHash: identity.currentContentHash
  })
  if (!candidate) return false
  volumeChapterDAO.updateChapterWithVersion(input.chapterId, {
    content: candidate.content,
    word_count: candidate.word_count,
    status: 'draft',
    quality_assessment_json: null,
    emotion_assessment_json: null
  })
  return true
}

async function commitAcceptedRepairCandidate(
  context: UnifiedNovelRepairContext,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
) {
  if (!signal) throw new Error('修复候选提交缺少运行取消信号')
  const chapter = volumeChapterDAO.getChapter(context.chapterId)
  if (!chapter?.content?.trim()) throw new Error('已验收修复候选正文不存在')
  const candidateBodyHash = bodyHash(chapter.content)
  updateNovelGoalState(context.workId, {
    repairCommitPending: {
      context,
      candidateBodyHash,
      acceptedAt: new Date().toISOString()
    }
  })
  try {
    if (context.decisionStatus === 'planned') {
      await prepareUnifiedNovelChapterCommit(
        context.workId,
        context.chapterId,
        config,
        signal,
        onProgress
      )
      const preparedChapter = volumeChapterDAO.getChapter(context.chapterId)
      if (
        !preparedChapter?.content?.trim()
        || bodyHash(preparedChapter.content) !== candidateBodyHash
      ) {
        updateNovelGoalState(context.workId, { repairCommitPending: undefined })
        throw new NovelRepairRevalidationRequiredError(context.chapterId)
      }
    }
    const committed = await commitUnifiedNovelRepair(
      context,
      config,
      signal,
      onProgress
    )
    updateNovelGoalState(context.workId, { repairCommitPending: undefined })
    return committed
  } catch (error) {
    onProgress?.('合格正文已冻结；权威提交失败时只恢复提交步骤，不再重新修订正文')
    throw error
  }
}

async function resumeAcceptedRepairCommit(
  workId: number,
  plan: RepairPlan,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<string | null> {
  let pending = readNovelGoalState(workId).repairCommitPending
  if (
    (plan.action === 'systemic' || plan.action === 'cluster')
    && plan.issueCodes?.includes('NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED')
  ) {
    if (pending) updateNovelGoalState(workId, { repairCommitPending: undefined })
    onProgress?.(
      plan.action === 'cluster'
        ? '重复模式来自当前章节结构合同；已废弃旧提交检查点并进入大纲重规划'
        : '跨章叙事记忆门禁要求产生新正文候选；已废弃旧提交检查点并进入语义修订'
    )
    return null
  }
  if (!pending && plan.targetChapterIds.length === 1) {
    const chapterId = plan.targetChapterIds[0]
    const decision = causalNovelDAO.getDecision(chapterId)
    const acceptanceSummary = getNovelChapterAcceptanceSummary(workId)
    if (
      decision?.status === 'planned'
      && acceptanceSummary?.chapterId === chapterId
      && ['running', 'accepted'].includes(acceptanceSummary.status)
    ) {
      onProgress?.('检测到正文已有部分验收检查点；只补跑缺失门禁，不重新修订正文')
      const acceptance = await runChapterConvergenceGate(
        workId,
        chapterId,
        config,
        signal,
        onProgress
      )
      if (!acceptance.passed) {
        throw repairGateError(
          chapterId,
          volumeChapterDAO.getChapter(chapterId)?.title ?? String(chapterId),
          acceptance
        )
      }
      const context = captureUnifiedNovelRepair(workId, chapterId)
      const committed = await commitAcceptedRepairCandidate(
        context,
        config,
        signal,
        onProgress
      )
      return `章节 ${chapterId} 已补齐全部门禁并提交到 r${committed.revision}`
    }
    if (
      decision?.status === 'planned'
      && strictChapterTransitionBlockers(workId, chapterId, config).length === 0
    ) {
      const version = causalNovelDAO.ensureCurrentContentVersion(
        workId,
        chapterId,
        'accepted_repair_recovery',
        'generated'
      )
      const memoryCheckpoint = causalNovelDAO.getCheckpoint(
        chapterId,
        version.id,
        'narrative_memory'
      )
      if (memoryCheckpoint?.status === 'completed') {
        pending = {
          context: captureUnifiedNovelRepair(workId, chapterId),
          candidateBodyHash: version.bodyHash,
          acceptedAt: new Date().toISOString()
        }
        updateNovelGoalState(workId, { repairCommitPending: pending })
      }
    }
  }
  if (!pending) return null
  const chapter = volumeChapterDAO.getChapter(pending.context.chapterId)
  if (
    !chapter?.content?.trim()
    || bodyHash(chapter.content) !== pending.candidateBodyHash
    || !plan.targetChapterIds.includes(pending.context.chapterId)
  ) {
    throw new NovelPipelineError(
      'CONTRACT_INVALID',
      '合格修复候选提交检查点与当前正文或修复计划不一致'
    )
  }
  onProgress?.(`正在从合格正文检查点恢复「${chapter.title}」权威提交`)
  const committed = await commitAcceptedRepairCandidate(
    pending.context,
    config,
    signal,
    onProgress
  )
  return `${chapter.title} 已从合格候选检查点提交到 r${committed.revision}`
}

async function reviseNovelStructuralCluster(
  workId: number,
  plan: RepairPlan,
  goal: string,
  signal?: AbortSignal,
  beforePersist?: () => void
): Promise<{ outlines: number; invalidatedBodies: number }> {
  const allChapters = volumeChapterDAO.listChaptersByWork(workId)
  const targets = allChapters.filter(chapter => plan.targetChapterIds.includes(chapter.id))
  if (targets.length === 0) throw new Error('结构修复没有可匹配的目标章节')
  const targetVolumes = [...new Set(targets.map(chapter => chapter.volume_id))]
  const structurallyAffectedIds = targetVolumes.flatMap(volumeId => {
    const volumeChapters = allChapters.filter(chapter => chapter.volume_id === volumeId)
    const firstTargetIndex = volumeChapters.findIndex(chapter => plan.targetChapterIds.includes(chapter.id))
    return firstTargetIndex < 0 ? [] : volumeChapters.slice(firstTargetIndex).map(chapter => chapter.id)
  })
  assertUnifiedStructuralRepairAllowed(workId, structurallyAffectedIds)

  const contextIds = new Set<number>()
  for (const target of targets) {
    const index = allChapters.findIndex(chapter => chapter.id === target.id)
    for (let offset = -1; offset <= 1; offset++) {
      const chapter = allChapters[index + offset]
      if (chapter) contextIds.add(chapter.id)
    }
  }
  const context = allChapters.filter(chapter => contextIds.has(chapter.id))
  const repairContext = context.map(chapter => {
    let diagnosis: Record<string, unknown> = {}
    try {
      diagnosis = JSON.parse(chapter.outline_diagnosis ?? '{}') as Record<string, unknown>
    } catch {
      // 损坏诊断不进入结构重规划输入；目标章必须由本次输出完整重建。
    }
    return {
      id: chapter.id,
      target: plan.targetChapterIds.includes(chapter.id),
      title: chapter.title,
      volume: chapter.volume_name,
      outline: chapter.outline,
      next_hook: chapter.next_hook,
      dramatic_contract: diagnosis.dramatic_contract,
      pattern_contract: diagnosis.pattern_contract,
      tension_plan: diagnosis.tension_plan,
      resource_budget: resourceLedgerDAO.listBudgetsByChapter(workId, chapter.id).map(budget => ({
        owner: budget.owner,
        resource: budget.resource,
        unit: budget.unit,
        start_min: budget.start_min,
        start_max: budget.start_max,
        end_min: budget.end_min,
        end_max: budget.end_max,
        allowed_events: budget.allowed_events,
        forbidden_events: budget.forbidden_events,
        reason: budget.reason
      }))
    }
  })
  const responseSchema = structuralRepairResponseSchema(plan.targetChapterIds)
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_repair_blueprint',
      enrichWorkContext: true,
      enrichNarrativeMemory: false,
      temperature: 0.2,
      thinkingEnabled: false,
      forceThinkingDisabled: true,
      maxTokens: 8000,
      responseSchema: {
        name: 'novel_structural_replan',
        schema: responseSchema,
        strict: true
      },
      structuredOutputMode: 'prompt_json',
      systemPrompt: [
        '你是长篇小说结构修复编辑。只输出合法JSON，不要markdown或解释。',
        '只修改target=true的章节；id必须原样返回。title是只读展示字段，不需要返回。不得修改章节数量或人物既有不可逆事实；resource_budget 是本次结构合同的可修复字段，必须根据确定性资源门禁补齐并保持与全书资源约束、前章结余连续。',
        '这是章节簇/整卷结构修复，必须从因果、解法、对手学习、阶段兑现、关系变化和卷级闭环上消除给定证据，不能只换措辞。',
        '每项必须返回完整 outline、next_hook、dramatic_contract、pattern_contract、tension_plan 与 resource_budget；resource_budget 必须覆盖所有数值资源约束，包含开章区间、章末区间、允许/禁止事件和理由。',
        'dramatic_contract.next_question 必须与 next_hook 指向同一个新悬念；pattern_contract.hook_type 必须描述该新悬念的模式。',
        'tension_plan.payoff_type 只允许 debt/partial/major/aftertaste，tension_plan.level 为 1-10 整数。',
        '输出结构只有一份：严格遵守 JSON Schema，不得把 tension_plan 展平为顶层字段。'
      ].join('\n'),
      prompt: [
        `【用户目标】\n${goal.trim() || '完成一部长篇小说'}`,
        `【结构问题与确定性证据】\n${plan.hint}`,
        `【目标与相邻章节】\n${JSON.stringify(repairContext, null, 2)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(response.error || '章节簇结构修复失败')
  }
  const json = extractJsonText(response.content.trim()) ?? response.content.trim()
  let parsed: { chapters?: Array<Record<string, unknown>> }
  try {
    parsed = JSON.parse(json) as typeof parsed
  } catch (error) {
    throw new Error(`章节簇结构修复解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  validatePromptJsonSchema(parsed, responseSchema)
  if (!Array.isArray(parsed.chapters)) throw new Error('章节簇结构修复缺少chapters数组')

  const preparedRows: Array<{
    id: number
    outline: string
    nextHook: string
    diagnosis: Record<string, unknown>
    resourceBudgets: ChapterResourceBudgetInput[]
  }> = []
  const seenTargetIds = new Set<number>()
  const validationFailures: string[] = []
  for (const row of parsed.chapters) {
    const id = Number(row.id)
    const target = targets.find(chapter => chapter.id === id)
    if (!target) {
      validationFailures.push(`未知目标id=${String(row.id)}`)
      continue
    }
    if (seenTargetIds.has(id)) {
      validationFailures.push(`重复目标id=${id}`)
      continue
    }
    seenTargetIds.add(id)
    const outline = String(row.outline ?? '').trim()
    const nextHook = String(row.next_hook ?? '').trim()
    const dramatic = row.dramatic_contract
    const pattern = row.pattern_contract
    const tension = row.tension_plan
    const resourceBudget = row.resource_budget
    const tensionRecord = tension && typeof tension === 'object' && !Array.isArray(tension)
      ? tension as Record<string, unknown>
      : undefined
    const tensionLevel = Number(tensionRecord?.level)
    const payoffType = String(tensionRecord?.payoff_type ?? '')
    if (
      !outline
      || !nextHook
      || !dramatic
      || typeof dramatic !== 'object'
      || Array.isArray(dramatic)
      || !pattern
      || typeof pattern !== 'object'
      || Array.isArray(pattern)
      || !tensionRecord
      || !Array.isArray(resourceBudget)
      || !['debt', 'partial', 'major', 'aftertaste'].includes(payoffType)
      || !Number.isInteger(tensionLevel)
      || tensionLevel < 1
      || tensionLevel > 10
    ) {
      validationFailures.push([
        `章节${id}`,
        !outline ? 'outline为空' : '',
        !nextHook ? 'next_hook为空' : '',
        !dramatic || typeof dramatic !== 'object' || Array.isArray(dramatic)
          ? 'dramatic_contract无效'
          : '',
        !pattern || typeof pattern !== 'object' || Array.isArray(pattern) ? 'pattern_contract无效' : '',
        !tensionRecord ? 'tension_plan无效' : '',
        !Array.isArray(resourceBudget) ? 'resource_budget无效' : '',
        !['debt', 'partial', 'major', 'aftertaste'].includes(payoffType) ? `payoff_type=${payoffType || '空'}` : '',
        !Number.isInteger(tensionLevel) || tensionLevel < 1 || tensionLevel > 10
          ? 'tension_level无效'
          : ''
      ].filter(Boolean).join('；'))
      continue
    }
    let diagnosis: Record<string, unknown> = {}
    try {
      diagnosis = JSON.parse(target.outline_diagnosis ?? '{}') as Record<string, unknown>
    } catch {
      // 旧诊断损坏时由本次结构修复重建。
    }
    diagnosis.dramatic_contract = dramatic
    diagnosis.pattern_contract = pattern
    diagnosis.tension_plan = { level: tensionLevel, payoff_type: payoffType }
    const resourceBudgets = (resourceBudget as Array<Record<string, unknown>>).map(budget => ({
      owner: typeof budget.owner === 'string' ? budget.owner : null,
      resource: String(budget.resource ?? '').trim(),
      unit: typeof budget.unit === 'string' ? budget.unit : null,
      start_min: typeof budget.start_min === 'number' ? budget.start_min : null,
      start_max: typeof budget.start_max === 'number' ? budget.start_max : null,
      end_min: typeof budget.end_min === 'number' ? budget.end_min : null,
      end_max: typeof budget.end_max === 'number' ? budget.end_max : null,
      allowed_events: typeof budget.allowed_events === 'string' ? budget.allowed_events : null,
      forbidden_events: typeof budget.forbidden_events === 'string' ? budget.forbidden_events : null,
      reason: typeof budget.reason === 'string' ? budget.reason : null
    }))
    preparedRows.push({ id, outline, nextHook, diagnosis, resourceBudgets })
  }
  if (preparedRows.length !== targets.length) {
    throw new Error(
      `章节簇结构修复仅返回 ${preparedRows.length}/${targets.length} 个有效目标：`
      + (validationFailures.join('｜') || '缺少目标章节id')
    )
  }

  const firstTargetIndex = allChapters.findIndex(chapter => chapter.id === plan.targetChapterIds[0])
  const previousChapterId = firstTargetIndex > 0 ? allChapters[firstTargetIndex - 1].id : null
  validateResourceBudgets(
    workId,
    previousChapterId,
    preparedRows.map(row => ({
      chapterNumber: allChapters.find(chapter => chapter.id === row.id)?.sort ?? row.id,
      budgets: row.resourceBudgets
    }))
  )

  const persist = (): { outlines: number; invalidatedBodies: number } => {
    beforePersist?.()
    for (const row of preparedRows) {
      volumeChapterDAO.updateChapterWithVersion(row.id, {
        outline: row.outline,
        next_hook: row.nextHook,
        outline_diagnosis: JSON.stringify(row.diagnosis)
      })
      resourceLedgerDAO.replaceBudgetsForChapter(workId, row.id, row.resourceBudgets)
    }

    let invalidatedBodies = 0
    const invalidatedVolumeNames = new Set<string>()
    for (const volumeId of targetVolumes) {
      const volumeChapters = allChapters.filter(chapter => chapter.volume_id === volumeId)
      if (volumeChapters[0]?.volume_name) invalidatedVolumeNames.add(volumeChapters[0].volume_name)
      const firstTargetIndex = volumeChapters.findIndex(chapter => plan.targetChapterIds.includes(chapter.id))
      if (firstTargetIndex < 0) continue
      for (const chapter of volumeChapters.slice(firstTargetIndex)) {
        clearChapterNarrativeMemory(workId, chapter.id)
        if (chapter.content?.trim()) invalidatedBodies++
        volumeChapterDAO.updateChapterWithVersion(chapter.id, {
          content: '',
          word_count: 0,
          status: 'draft',
          emotion_assessment_json: null
        })
      }
    }
    discardUnifiedPlannedDecisions(structurallyAffectedIds)
    const state = readNovelGoalState(workId)
    updateNovelGoalState(workId, {
      checkedBodyVolumes: (state.checkedBodyVolumes ?? [])
        .filter(name => !invalidatedVolumeNames.has(name))
    })
    return { outlines: preparedRows.length, invalidatedBodies }
  }
  const database = getDatabase()
  return database.inTransaction ? persist() : database.transaction(persist)()
}

async function reviseCommittedDependencyClosure(
  workId: number,
  plan: RepairPlan,
  goal: string,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<string> {
  const orderedTargets = volumeChapterDAO.listChaptersByWork(workId)
    .filter(chapter => plan.targetChapterIds.includes(chapter.id))
  const summaries: string[] = []
  for (const chapter of orderedTargets) {
    assertNotAborted(signal)
    await ensureUnifiedNovelDecision(
      workId, chapter.id, goal, signal, onProgress, config.checkEmotionContract
    )
    const context = captureUnifiedNovelRepair(workId, chapter.id)
    clearChapterNarrativeMemory(workId, chapter.id)
    onProgress?.(`正在修订依赖闭包「${chapter.title}」`)
    const revised = await reviseBeatBody(workId, chapter.id, {
      signal,
      instruction: [
        plan.hint,
        '这是自治依赖闭包修复。必须保持已提交硬事实成立，修复当前证据，并让后续因果能够从新正文重新推出。'
      ].join('\n'),
      workType: 'novel',
      deferNarrativeMemory: true,
      checkEmotionContract: config.checkEmotionContract,
      beforePersist: plan.action === 'cluster'
        ? () => reserveChapterTransactionPatch({
            workId,
            chapterId: chapter.id,
            failureKind: plan.issueCodes?.[0] ?? 'structural_replan',
            lane: 'structural_replan'
          })
        : undefined
    })
    assertGeneratedRepair(revised)
    const acceptance = await runChapterConvergenceGate(
      workId,
      chapter.id,
      config,
      signal,
      onProgress
    )
    if (!acceptance.passed) {
      discardUnifiedNovelRepairCandidate(context)
      throw repairGateError(
        chapter.id,
        chapter.title,
        acceptance
      )
    }
    const committed = await commitAcceptedRepairCandidate(
      context,
      config,
      signal,
      onProgress
    )
    summaries.push(
      `${chapter.title} 提交到 r${committed.revision}`
      + (committed.replayedChapters > 0 ? `，重放 ${committed.replayedChapters} 章` : '')
    )
  }
  return summaries.join('；')
}

export async function runVolumeBodyCheckpoint(
  workId: number,
  chapterId: number,
  goal: string,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ passed: boolean; summary: string }> {
  const all = volumeChapterDAO.listChaptersByWork(workId)
  const current = all.find(chapter => chapter.id === chapterId)
  if (!current) return { passed: true, summary: '' }
  const volumeChapters = all.filter(chapter => chapter.volume_id === current.volume_id)
  if (volumeChapters.at(-1)?.id !== chapterId || volumeChapters.some(chapter => !chapter.content?.trim())) {
    return { passed: true, summary: '' }
  }
  const state = readNovelGoalState(workId)
  if (state.checkedBodyVolumes?.includes(current.volume_name)) return { passed: true, summary: '' }
  updateNovelGoalState(workId, {
    checkedBodyVolumes: [...new Set([...(state.checkedBodyVolumes ?? []), current.volume_name])]
  })
  onProgress?.(`「${current.volume_name}」正文已完整提交；卷级主观审读合并到整书一次性抽样终审`)
  return {
    passed: true,
    summary: `已完成 ${volumeChapters.length} 章的权威提交，不启动卷内概率修复循环`
  }
}

export async function executeNovelRepairPlan(
  workId: number,
  requestedPlan: RepairPlan,
  goal: string,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<string> {
  const existingChapterIds = new Set(
    volumeChapterDAO.listChaptersByWork(workId).map(chapter => chapter.id)
  )
  const targetChapterIds = [...new Set(requestedPlan.targetChapterIds)]
    .filter(chapterId => existingChapterIds.has(chapterId))
  if (requestedPlan.targetChapterIds.length > 0 && targetChapterIds.length === 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', '修复计划没有可解析的章节目标')
  }
  const plan = { ...requestedPlan, targetChapterIds }
  if (plan.action === 'normalize_length' && plan.wordRange) {
    const classifiedAction = classifyWordRangeRepairAction(plan.wordRange)
    if (classifiedAction !== 'normalize_length') {
      plan.action = classifiedAction
      plan.hint = classifiedAction === 'expand'
        ? [
            `当前正文 ${plan.wordRange.actual} 字，距离最低合同 ${plan.wordRange.min} 字的偏差已超过局部归一化边界。`,
            '废弃补丁式填充；按冻结章节合同与场景清单完整重生当前未提交正文，逐场兑现行动、因果与反馈。'
          ].join('\n')
        : [
            `当前正文 ${plan.wordRange.actual} 字，超过最高合同 ${plan.wordRange.max} 字的偏差已超过局部归一化边界。`,
            '废弃逐句裁切；按冻结章节合同完整重生当前未提交正文，保留全部承重事件并压紧场景执行。'
          ].join('\n')
    }
  }
  const resumedCommit = await resumeAcceptedRepairCommit(
    workId,
    plan,
    config,
    signal,
    onProgress
  )
  if (resumedCommit) return resumedCommit

  if (plan.action === 'draft_missing') {
    const summaries: string[] = []
    for (const chapterId of plan.targetChapterIds) {
      assertNotAborted(signal)
      const chapter = volumeChapterDAO.getChapter(chapterId)
      onProgress?.(`正在生成缺失章节「${chapter?.title ?? chapterId}」`)
      await ensureUnifiedNovelDecision(
        workId, chapterId, goal, signal, onProgress, config.checkEmotionContract
      )
      const repairContext = captureUnifiedNovelRepair(workId, chapterId)
      clearChapterNarrativeMemory(workId, chapterId)
      const generated = await generateBeatBody(workId, chapterId, {
        signal,
        goalDescription: goal,
        workType: 'novel',
        deferNarrativeMemory: true,
        checkEmotionContract: config.checkEmotionContract
      })
      assertGeneratedRepair(generated)
      const gate = await runChapterConvergenceGate(workId, chapterId, config, signal, onProgress)
      if (!gate.passed) {
        settleRejectedRepairCandidate(repairContext)
        throw repairGateError(
          chapterId,
          chapter?.title ?? String(chapterId),
          gate
        )
      }
      const committed = await commitAcceptedRepairCandidate(
        repairContext,
        config,
        signal,
        onProgress
      )
      summaries.push(
        `${chapter?.title ?? chapterId} ${generated.wordCount}字，章节硬合同通过，`
        + `权威状态提交到 r${committed.revision}`
      )
    }
    return summaries.join('；')
  }

  if (
    (plan.action === 'cluster' || plan.action === 'volume')
    && (plan.scope === 'cluster' || plan.scope === 'volume')
  ) {
    const hasCommittedTargets = plan.targetChapterIds.some(chapterId =>
      causalNovelDAO.getDecision(chapterId)?.status === 'committed'
    )
    if (hasCommittedTargets) {
      onProgress?.(`正在执行${plan.scope === 'volume' ? '卷级' : '章节簇'}依赖闭包修复`)
      return reviseCommittedDependencyClosure(
        workId,
        plan,
        goal,
        config,
        signal,
        onProgress
      )
    }
    onProgress?.(`正在执行${plan.scope === 'volume' ? '整卷' : '章节簇'}结构修复`)
    const result = await reviseNovelStructuralCluster(
      workId,
      plan,
      goal,
      signal
    )
    return `重构 ${result.outlines} 章大纲，级联失效 ${result.invalidatedBodies} 章正文，将按新状态顺序重生`
  }

  const summaries: string[] = []
  for (const chapterId of plan.targetChapterIds) {
    assertNotAborted(signal)
    let chapter = volumeChapterDAO.getChapter(chapterId)
    if (!chapter) continue
    if (!chapter.content?.trim()) {
      throw new NovelRepairGenerationRequiredError(chapterId, chapter.title)
    }
    await ensureUnifiedNovelDecision(
      workId, chapterId, goal, signal, onProgress, config.checkEmotionContract
    )
    if (restoreWordCompliantPlannedCandidate({
      workId,
      chapterId,
      config
    })) {
      onProgress?.(`已恢复「${chapter.title}」通过字数合同的工作候选，继续执行当前语义门禁补丁`)
      chapter = volumeChapterDAO.getChapter(chapterId)
      if (!chapter) throw new Error(`恢复工作候选后章节 ${chapterId} 不存在`)
    }
    const repairContext = captureUnifiedNovelRepair(workId, chapterId)
    clearChapterNarrativeMemory(workId, chapterId)
    let summary = ''
    let bodyChanged = false

    if (plan.issueCodes?.includes('MISSING_PATTERN_FINGERPRINT') && chapter.content?.trim()) {
      onProgress?.(`「${chapter.title}」将在复验后重新提取状态与模式指纹`)
      summary = `${chapter.title} 等待复验后补抽取状态与模式指纹`
    } else {
      let instruction = `${plan.hint || '强化创作目标匹配度'}\n用户目标：${goal}`
      if (plan.action === 'normalize_length') {
        if (!plan.wordRange) {
          throw new NovelPipelineError('CONTRACT_INVALID', '字数归一化计划缺少结构化字数范围')
        }
        instruction = [
          `当前正文 ${plan.wordRange.actual} 字，必须在不改变冻结章节合同的前提下重写到 ${plan.wordRange.min}-${plan.wordRange.max} 字。`,
          '正文是章节事务的原子候选，不生成插入补丁、不拼接句段；完整重写当前未提交正文，保留全部承重事件、因果次序、人物选择与章末问题。',
          `用户目标：${goal}`
        ].join('\n')
        onProgress?.(`正在按冻结章节合同整体归一化「${chapter.title}」正文`)
      } else if (plan.action === 'systemic') {
        instruction = `${plan.hint}\n只修改与确定性证据冲突的事实；既有不可逆状态优先，不得用模糊措辞掩盖冲突。`
        onProgress?.(`正在修复承重状态「${chapter.title}」`)
      } else if (plan.action === 'execution_contract') {
        instruction = `${plan.hint}\n只修复未覆盖情节点、提前越界或跨章衔接证据；禁止顺带重写文风、情绪或其他已通过内容。`
        onProgress?.(`正在执行章节合同唯一补丁「${chapter.title}」`)
      } else if (plan.action === 'expand' || plan.action === 'compress') {
        instruction = plan.hint
        onProgress?.(`正在${plan.action === 'expand' ? '扩写' : '压缩'}「${chapter.title}」`)
      } else if (plan.action === 'quality') {
        onProgress?.(`正在定向精修「${chapter.title}」`)
        const diagnosis = await diagnoseChapterQualityAi(
          workId,
          chapterId,
          chapter.content ?? '',
          { thinkingEnabled: getGoalLoopModelOpts(workId).thinkingEnabled }
        )
        if (!diagnosis.success || !diagnosis.report) {
          throw new Error(diagnosis.error || '质量诊断未返回报告')
        }
        instruction = `根据以下质量诊断逐项修复，优先处理硬失败、因果、人设、设定、大纲覆盖和章末钩子：\n${diagnosis.report}`
      } else if (plan.action === 'emotion') {
        onProgress?.(`正在定向修复情绪门禁「${chapter.title}」`)
        instruction = plan.hint
        try {
          const assessment = chapter.emotion_assessment_json
            ? JSON.parse(chapter.emotion_assessment_json)
            : null
          if (assessment) instruction = emotionRepairHint(assessment)
        } catch {
          // 使用修复计划中的确定性提示。
        }
      } else if (plan.action === 'deai') {
        onProgress?.(`正在去AI/修复一致性「${chapter.title}」`)
        const gate = runConsistencyGate(
          workId,
          chapterId,
          chapter.content ?? '',
          { requireTimeline: false }
        )
        instruction = `请修复以下问题：${
          [gate.blockers.join('；'), plan.hint].filter(Boolean).join('；')
          || '去除AI腔、提升叙事自然度'
        }`
      } else {
        onProgress?.(`正在优化目标匹配「${chapter.title}」`)
      }
      const executionContract = persistChapterExecutionContract(
        workId,
        chapterId,
        config.wordsPerChapter ?? undefined,
        config.wordCountTolerance
      )
      if (!executionContract) {
        throw new NovelPipelineError('CONTRACT_INVALID', '章节修订缺少冻结执行合同')
      }
      const requiredWordRange = plan.wordRange ?? {
        min: executionContract.wordMin,
        target: executionContract.wordTarget,
        max: executionContract.wordMax
      }
      const generated = await reviseBeatBody(workId, chapterId, {
        signal,
        instruction,
        workType: 'novel',
        wordTargetOverride: requiredWordRange.target,
        requiredWordRange,
        deferNarrativeMemory: true,
        checkEmotionContract: config.checkEmotionContract,
        beforePersist: () => reserveChapterTransactionPatch({
          workId,
          chapterId,
          failureKind: plan.issueCodes?.[0] ?? plan.action,
          lane: 'semantic_repair'
        })
      })
      assertGeneratedRepair(generated)
      bodyChanged = true
      summary = plan.action === 'expand' || plan.action === 'compress'
        ? `${chapter.title} ${generated.wordCount}字`
        : `${chapter.title} 已完成${plan.action}修复`
    }

    const acceptance = await runChapterConvergenceGate(
      workId,
      chapterId,
      config,
      signal,
      onProgress
    )
    if (!acceptance.passed) {
      settleRejectedRepairCandidate(repairContext)
      throw repairGateError(
        chapterId,
        chapter.title,
        acceptance
      )
    }
    const committed = await commitAcceptedRepairCandidate(
      repairContext,
      config,
      signal,
      onProgress
    )
    if (bodyChanged) {
      const state = readNovelGoalState(workId)
      const volumeName = volumeChapterDAO.listVolumes(workId)
        .find(volume => volume.id === chapter.volume_id)?.name
      updateNovelGoalState(workId, {
        checkedBodyVolumes: (state.checkedBodyVolumes ?? [])
          .filter(name => name !== volumeName)
      })
    }
    summaries.push(
      `${summary}，复验通过，权威状态 r${committed.revision}`
      + (committed.replayedChapters > 0 ? `，重放 ${committed.replayedChapters} 章` : '')
    )
  }
  return summaries.join('；') || '无需修复'
}
