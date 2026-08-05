import type Database from 'better-sqlite3'
import type { ChapterIntent } from '../chapter-contracts'
import { NarrativeChapterPipeline } from '../chapter-pipeline'
import { NarrativeKernelError, assertNarrativeKernel } from '../errors'
import { canonicalHash, canonicalJson, sha256 } from '../hash'
import {
  materializeAutoChapterIntent,
  parseAutoChapterIntentPlan,
  parseAutoNovelBlueprint,
  type AutoNovelBlueprint
} from './auto-novel-contracts'
import { AutomatedChapterRunner } from './chapter-runner'
import type { NarrativeWorkflowPhase, NarrativeWorkflowStatus } from './workflow-store'
import {
  assertCompletedModelResponse,
  createFrozenNarrativeModelContract,
  type FrozenNarrativeModelContract,
  type FrozenNarrativeModelContractInput,
  type NarrativeModelGateway,
  type NarrativeModelTask
} from './model-contract'
import { ensureNarrativeEventStoreSchema } from '../storage/schema'

export type AutoNovelRunStatus = 'running' | 'blocked' | 'cancelled' | 'completed'
export type AutoNovelPhase = 'plan_novel' | 'generate_chapter' | 'completed'

export interface AutoNovelRun {
  id: string
  novelId: number
  status: AutoNovelRunStatus
  desiredState: 'running' | 'cancelled'
  currentPhase: AutoNovelPhase
  targetChapters: number
  wordRange: { min: number; max: number }
  premise: string
  recoveredFromRunId?: string
  blueprint?: AutoNovelBlueprint
  activeChapterRunId?: string
  modelContract: FrozenNarrativeModelContract
  errorCode?: string
  errorMessage?: string
}

export interface StartAutoNovelInput {
  runId: string
  novelId: number
  premise: string
  targetChapters: number
  wordRange: { min: number; max: number }
  modelContract: FrozenNarrativeModelContractInput
}

export interface RecoverAutoNovelInput {
  sourceRunId: string
  runId: string
  modelContract: FrozenNarrativeModelContractInput
}

export interface AutoNovelProgress {
  run: AutoNovelRun
  committedChapterCount: number
  currentChapter?: {
    ordinal: number
    status: NarrativeWorkflowStatus
    phase: NarrativeWorkflowPhase
    editorialGateIndex: number
    editorialGateCount: number
    repairCount: number
    maxRepairs: number
    candidate?: {
      id: string
      content: string
      wordCount: number
    }
  }
}

interface AutoRunRow {
  id: string
  novel_id: number
  status: AutoNovelRunStatus
  desired_state: 'running' | 'cancelled'
  current_phase: AutoNovelPhase
  target_chapters: number
  word_min: number
  word_max: number
  premise: string
  recovered_from_run_id: string | null
  blueprint_json: string | null
  blueprint_hash: string | null
  active_chapter_run_id: string | null
  model_contract_json: string
  model_contract_hash: string
  error_code: string | null
  error_message: string | null
}

interface CallRow {
  status: 'running' | 'completed' | 'failed'
  request_hash: string
  response_json: string | null
  response_hash: string | null
  error_code: string | null
  error_message: string | null
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof NarrativeKernelError) return { code: error.code, message: error.message }
  return {
    code: 'WORKFLOW_STATE_INVALID',
    message: error instanceof Error ? error.message : String(error)
  }
}

function mapRun(row: AutoRunRow): AutoNovelRun {
  const modelContract = JSON.parse(row.model_contract_json) as FrozenNarrativeModelContract
  assertNarrativeKernel(
    modelContract.contractHash === row.model_contract_hash &&
      canonicalHash({
        provider: modelContract.provider,
        providerProtocol: modelContract.providerProtocol,
        apiBase: modelContract.apiBase,
        model: modelContract.model,
        protocolVersion: modelContract.protocolVersion
      }) === row.model_contract_hash,
    'PIPELINE_ARTIFACT_HASH_MISMATCH',
    '自动全书运行的冻结模型契约已损坏',
    { runId: row.id }
  )
  let blueprint: AutoNovelBlueprint | undefined
  if (row.blueprint_json != null) {
    const parsed = JSON.parse(row.blueprint_json) as AutoNovelBlueprint
    const { blueprintHash: _hash, ...payload } = parsed
    assertNarrativeKernel(
      parsed.blueprintHash === row.blueprint_hash && canonicalHash(payload) === row.blueprint_hash,
      'PIPELINE_ARTIFACT_HASH_MISMATCH',
      '自动全书蓝图已损坏',
      { runId: row.id }
    )
    blueprint = parsed
  }
  return {
    id: row.id,
    novelId: row.novel_id,
    status: row.status,
    desiredState: row.desired_state,
    currentPhase: row.current_phase,
    targetChapters: row.target_chapters,
    wordRange: { min: row.word_min, max: row.word_max },
    premise: row.premise,
    ...(row.recovered_from_run_id ? { recoveredFromRunId: row.recovered_from_run_id } : {}),
    ...(blueprint ? { blueprint } : {}),
    ...(row.active_chapter_run_id ? { activeChapterRunId: row.active_chapter_run_id } : {}),
    modelContract,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {})
  }
}

export class AutomatedNovelRunner {
  readonly pipeline: NarrativeChapterPipeline
  readonly chapters: AutomatedChapterRunner

  constructor(
    private readonly db: Database.Database,
    private readonly gateway: NarrativeModelGateway
  ) {
    ensureNarrativeEventStoreSchema(db)
    this.pipeline = new NarrativeChapterPipeline(db)
    this.chapters = new AutomatedChapterRunner(db, gateway)
  }

  start(input: StartAutoNovelInput): AutoNovelRun {
    assertNarrativeKernel(
      input.runId.trim().length > 0 && input.premise.trim().length > 0 &&
        Number.isInteger(input.targetChapters) && input.targetChapters > 0 &&
        input.targetChapters <= 2000 && Number.isInteger(input.wordRange.min) &&
        Number.isInteger(input.wordRange.max) && input.wordRange.min > 0 &&
        input.wordRange.max >= input.wordRange.min,
      'WORKFLOW_STATE_INVALID',
      '自动全书运行输入无效'
    )
    this.pipeline.loadState(input.novelId)
    const active = this.db.prepare(`
      SELECT id FROM narrative_auto_novel_runs WHERE novel_id = ? AND status = 'running'
    `).get(input.novelId) as { id: string } | undefined
    assertNarrativeKernel(
      !active,
      'WORKFLOW_STATE_INVALID',
      '当前小说已有自动全书运行，必须先恢复或取消',
      { novelId: input.novelId, runId: active?.id }
    )
    const modelContract = createFrozenNarrativeModelContract(input.modelContract)
    this.db.prepare(`
      INSERT INTO narrative_auto_novel_runs (
        id, novel_id, status, desired_state, current_phase, target_chapters,
        word_min, word_max, premise, model_contract_json, model_contract_hash
      ) VALUES (?, ?, 'running', 'running', 'plan_novel', ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.novelId,
      input.targetChapters,
      input.wordRange.min,
      input.wordRange.max,
      input.premise.trim(),
      canonicalJson(modelContract),
      modelContract.contractHash
    )
    return this.loadRun(input.runId)
  }

  listRuns(novelId: number, limit = 20): AutoNovelRun[] {
    return this.db.prepare(`
      SELECT id, novel_id, status, desired_state, current_phase, target_chapters,
             word_min, word_max, premise, recovered_from_run_id, blueprint_json, blueprint_hash,
             active_chapter_run_id, model_contract_json, model_contract_hash,
             error_code, error_message
      FROM narrative_auto_novel_runs
      WHERE novel_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(novelId, limit).map(row => mapRun(row as AutoRunRow))
  }

  loadRun(runId: string): AutoNovelRun {
    const row = this.db.prepare(`
      SELECT id, novel_id, status, desired_state, current_phase, target_chapters,
             word_min, word_max, premise, recovered_from_run_id, blueprint_json, blueprint_hash,
             active_chapter_run_id, model_contract_json, model_contract_hash,
             error_code, error_message
      FROM narrative_auto_novel_runs WHERE id = ?
    `).get(runId) as AutoRunRow | undefined
    assertNarrativeKernel(row, 'WORKFLOW_RUN_NOT_FOUND', '自动全书运行不存在', { runId })
    return mapRun(row)
  }

  recover(input: RecoverAutoNovelInput): AutoNovelRun {
    const source = this.loadRun(input.sourceRunId)
    assertNarrativeKernel(
      source.status === 'blocked',
      'WORKFLOW_STATE_INVALID',
      '只有已暂停的自动全书运行可以恢复',
      { runId: source.id, status: source.status }
    )
    assertNarrativeKernel(
      input.runId.trim().length > 0 && input.runId !== source.id,
      'WORKFLOW_STATE_INVALID',
      '恢复运行 ID 无效',
      { sourceRunId: source.id, runId: input.runId }
    )
    this.pipeline.loadState(source.novelId)
    const active = this.db.prepare(`
      SELECT id FROM narrative_auto_novel_runs WHERE novel_id = ? AND status = 'running'
    `).get(source.novelId) as { id: string } | undefined
    assertNarrativeKernel(!active, 'WORKFLOW_STATE_INVALID', '当前小说已有自动全书运行', {
      novelId: source.novelId,
      runId: active?.id
    })
    const modelContract = createFrozenNarrativeModelContract(input.modelContract)
    const currentPhase: AutoNovelPhase = source.blueprint ? 'generate_chapter' : 'plan_novel'
    this.db.prepare(`
      INSERT INTO narrative_auto_novel_runs (
        id, novel_id, status, desired_state, current_phase, target_chapters,
        word_min, word_max, premise, recovered_from_run_id, blueprint_json, blueprint_hash,
        model_contract_json, model_contract_hash
      ) VALUES (?, ?, 'running', 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      source.novelId,
      currentPhase,
      source.targetChapters,
      source.wordRange.min,
      source.wordRange.max,
      source.premise,
      source.id,
      source.blueprint ? canonicalJson(source.blueprint) : null,
      source.blueprint?.blueprintHash ?? null,
      canonicalJson(modelContract),
      modelContract.contractHash
    )
    return this.loadRun(input.runId)
  }

  progress(runId: string): AutoNovelProgress {
    const run = this.loadRun(runId)
    const committedChapterCount = this.pipeline.listCommittedChapters(run.novelId).length
    if (!run.activeChapterRunId) return { run, committedChapterCount }
    const chapterRun = this.chapters.workflows.loadRun(run.activeChapterRunId)
    const intent = this.pipeline.loadIntent(chapterRun.intentId)
    const candidate = chapterRun.candidateId
      ? this.pipeline.loadCandidate(chapterRun.candidateId)
      : undefined
    return {
      run,
      committedChapterCount,
      currentChapter: {
        ordinal: intent.chapterOrdinal,
        status: chapterRun.status,
        phase: chapterRun.currentPhase,
        editorialGateIndex: chapterRun.editorialGateIndex,
        editorialGateCount: 6,
        repairCount: chapterRun.repairCount,
        maxRepairs: chapterRun.maxRepairs,
        ...(candidate
          ? {
              candidate: {
                id: candidate.id,
                content: candidate.content,
                wordCount: candidate.wordCount
              }
            }
          : {})
      }
    }
  }

  requestCancellation(runId: string): AutoNovelRun {
    const run = this.loadRun(runId)
    if (run.status !== 'running') return run
    this.db.prepare(`
      UPDATE narrative_auto_novel_runs
      SET desired_state = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `).run(runId)
    if (run.activeChapterRunId) this.chapters.workflows.requestCancellation(run.activeChapterRunId)
    return this.loadRun(runId)
  }

  async runToTerminal(runId: string, owner = 'auto-novel-runner'): Promise<AutoNovelRun> {
    let run = this.loadRun(runId)
    if (run.status !== 'running') return run
    this.claim(runId, owner)
    try {
      for (let transition = 0; transition < run.targetChapters * 4 + 8; transition += 1) {
        run = this.loadRun(runId)
        if (run.status !== 'running') return run
        if (run.desiredState === 'cancelled') {
          this.updateRun(run.id, { status: 'cancelled' })
          return this.loadRun(run.id)
        }
        try {
          if (run.currentPhase === 'plan_novel') await this.planNovel(run)
          else if (run.currentPhase === 'generate_chapter') await this.generateNextChapter(run)
          else {
            this.updateRun(run.id, { status: 'completed' })
          }
        } catch (error) {
          const failure = errorDetails(error)
          this.updateRun(run.id, {
            status: 'blocked',
            errorCode: failure.code,
            errorMessage: failure.message
          })
        }
      }
      run = this.loadRun(runId)
      if (run.status === 'running') {
        this.updateRun(run.id, {
          status: 'blocked',
          errorCode: 'WORKFLOW_STATE_INVALID',
          errorMessage: '自动全书运行超过最大状态转移次数'
        })
      }
      return this.loadRun(runId)
    } finally {
      this.release(runId, owner)
    }
  }

  private async planNovel(run: AutoNovelRun): Promise<void> {
    const title = this.pipeline.loadNovelTitle(run.novelId)
    const value = await this.structuredCall(run, 'novel_blueprint', `${run.id}:blueprint`, {
      novelId: run.novelId,
      title,
      premise: run.premise,
      targetChapters: run.targetChapters,
      wordRange: run.wordRange
    })
    const blueprint = parseAutoNovelBlueprint(value, run.targetChapters)
    this.updateRun(run.id, {
      currentPhase: 'generate_chapter',
      blueprint,
      errorCode: null,
      errorMessage: null
    })
  }

  private async generateNextChapter(run: AutoNovelRun): Promise<void> {
    const chapters = this.pipeline.listCommittedChapters(run.novelId)
    if (chapters.length >= run.targetChapters) {
      this.updateRun(run.id, { currentPhase: 'completed', status: 'completed' })
      return
    }
    assertNarrativeKernel(run.blueprint, 'WORKFLOW_STATE_INVALID', '自动全书运行缺少蓝图')
    const ordinal = chapters.length + 1
    const state = this.pipeline.loadState(run.novelId)
    const chapterRunId = `${run.id}:chapter:${ordinal}`
    const intentId = `${run.id}:intent:${ordinal}`
    let intent: ChapterIntent
    try {
      intent = this.pipeline.loadIntent(intentId)
    } catch (error) {
      if (!(error instanceof NarrativeKernelError) || error.code !== 'CHAPTER_INTENT_INVALID') throw error
      const plan = await this.generateValidatedChapterIntentPlan(run, ordinal, state)
      intent = this.pipeline.registerIntent(materializeAutoChapterIntent({
        id: intentId,
        workId: run.novelId,
        chapterOrdinal: ordinal,
        baseStateRevision: state.revision,
        wordRange: run.wordRange,
        plan
      }))
    }
    let chapterRun
    try {
      chapterRun = this.chapters.workflows.loadRun(chapterRunId)
    } catch (error) {
      if (!(error instanceof NarrativeKernelError) || error.code !== 'WORKFLOW_RUN_NOT_FOUND') throw error
      chapterRun = this.chapters.start({
        runId: chapterRunId,
        novelId: run.novelId,
        intentId: intent.id,
        maxRepairs: 2,
        maxStepAttempts: 2,
        editorialPolicyVersion: 1,
        modelContract: run.modelContract
      })
    }
    this.updateRun(run.id, { activeChapterRunId: chapterRun.id })
    const finished = await this.chapters.runToTerminal(chapterRun.id, `${run.id}:chapter-runner`)
    if (finished.status !== 'completed') {
      throw new NarrativeKernelError(
        'WORKFLOW_STATE_INVALID',
        '自动全书运行的章节执行未完成',
        { chapterRunId: finished.id, status: finished.status, errorCode: finished.errorCode }
      )
    }
    this.updateRun(run.id, { activeChapterRunId: null, errorCode: null, errorMessage: null })
  }

  private async structuredCall(
    run: AutoNovelRun,
    task: Extract<NarrativeModelTask, 'novel_blueprint' | 'chapter_intent'>,
    requestId: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    const request = { requestId, task, contract: run.modelContract, input }
    const requestJson = canonicalJson(request)
    const requestHash = sha256(requestJson)
    const existing = this.db.prepare(`
      SELECT status, request_hash, response_json, response_hash, error_code, error_message
      FROM narrative_auto_novel_model_calls WHERE request_id = ?
    `).get(requestId) as CallRow | undefined
    if (existing?.status === 'running') {
      throw new NarrativeKernelError('MODEL_CALL_OUTCOME_UNKNOWN', '自动全书模型调用结果未知', { requestId })
    }
    if (existing?.status === 'completed') {
      assertNarrativeKernel(
        existing.request_hash === requestHash && existing.response_json &&
          sha256(existing.response_json) === existing.response_hash,
        'PIPELINE_ARTIFACT_HASH_MISMATCH',
        '自动全书模型调用缓存已损坏',
        { requestId }
      )
      return JSON.parse(existing.response_json)
    }
    if (existing?.status === 'failed') {
      throw new NarrativeKernelError(
        'MODEL_CALL_FAILED',
        existing.error_message || '自动全书模型调用此前已失败',
        { requestId, errorCode: existing.error_code }
      )
    }
    this.db.prepare(`
      INSERT INTO narrative_auto_novel_model_calls (
        id, request_id, run_id, task, request_json, request_hash, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'running')
    `).run(requestId, requestId, run.id, task, requestJson, requestHash)
    try {
      const response = await this.gateway.invoke(request)
      assertCompletedModelResponse(response, 'structured')
      const responseJson = canonicalJson(response.structuredOutput)
      this.db.prepare(`
        UPDATE narrative_auto_novel_model_calls
        SET status = 'completed', response_json = ?, response_hash = ?, finished_at = CURRENT_TIMESTAMP
        WHERE request_id = ? AND status = 'running'
      `).run(responseJson, sha256(responseJson), requestId)
      return response.structuredOutput
    } catch (error) {
      const failure = errorDetails(error)
      this.db.prepare(`
        UPDATE narrative_auto_novel_model_calls
        SET status = 'failed', error_code = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
        WHERE request_id = ? AND status = 'running'
      `).run(failure.code, failure.message, requestId)
      throw error
    }
  }

  private async generateValidatedChapterIntentPlan(
    run: AutoNovelRun,
    chapterOrdinal: number,
    state: ReturnType<NarrativeChapterPipeline['loadState']>
  ) {
    let previousFailure: { code: string; message: string } | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const value = await this.structuredCall(
        run,
        'chapter_intent',
        `${run.id}:chapter-intent:${chapterOrdinal}:attempt:${attempt + 1}`,
        {
          blueprint: run.blueprint,
          chapterOrdinal,
          targetChapters: run.targetChapters,
          state,
          wordRange: run.wordRange,
          ...(previousFailure ? { protocolRepair: previousFailure } : {})
        }
      )
      try {
        return parseAutoChapterIntentPlan(value)
      } catch (error) {
        previousFailure = errorDetails(error)
      }
    }
    throw new NarrativeKernelError(
      'WORKFLOW_STATE_INVALID',
      `下一章契约连续两次不符合固定 JSON 协议：${previousFailure?.message ?? '未知原因'}`,
      { runId: run.id, chapterOrdinal, failureCode: previousFailure?.code }
    )
  }

  private claim(runId: string, owner: string): void {
    const now = Date.now()
    const updated = this.db.prepare(`
      UPDATE narrative_auto_novel_runs
      SET lease_owner = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ? OR lease_owner = ?)
    `).run(owner, now + 15 * 60 * 1000, runId, now, owner)
    assertNarrativeKernel(
      updated.changes === 1,
      'WORKFLOW_LEASE_UNAVAILABLE',
      '自动全书运行正在被其他执行器持有',
      { runId }
    )
  }

  private release(runId: string, owner: string): void {
    this.db.prepare(`
      UPDATE narrative_auto_novel_runs
      SET lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND lease_owner = ?
    `).run(runId, owner)
  }

  private updateRun(inputId: string, patch: {
    status?: AutoNovelRunStatus
    currentPhase?: AutoNovelPhase
    blueprint?: AutoNovelBlueprint
    activeChapterRunId?: string | null
    errorCode?: string | null
    errorMessage?: string | null
  }): void {
    const current = this.loadRun(inputId)
    const blueprintJson = patch.blueprint ? canonicalJson(patch.blueprint) : undefined
    this.db.prepare(`
      UPDATE narrative_auto_novel_runs
      SET status = ?, current_phase = ?, blueprint_json = ?, blueprint_hash = ?,
          active_chapter_run_id = ?, error_code = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      patch.status ?? current.status,
      patch.currentPhase ?? current.currentPhase,
      blueprintJson ?? (current.blueprint ? canonicalJson(current.blueprint) : null),
      patch.blueprint?.blueprintHash ?? current.blueprint?.blueprintHash ?? null,
      patch.activeChapterRunId === undefined ? current.activeChapterRunId ?? null : patch.activeChapterRunId,
      patch.errorCode === undefined ? current.errorCode ?? null : patch.errorCode,
      patch.errorMessage === undefined ? current.errorMessage ?? null : patch.errorMessage,
      inputId
    )
  }
}
