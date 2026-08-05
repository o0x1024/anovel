import type Database from 'better-sqlite3'
import {
  REQUIRED_EDITORIAL_GATES,
  type ChapterCandidate,
  type EditorialGateType
} from '../chapter-contracts'
import { NarrativeChapterPipeline } from '../chapter-pipeline'
import { NarrativeKernelError } from '../errors'
import { canonicalHash } from '../hash'
import { parseEditorialGateOutput } from './editorial-parser'
import {
  assertCompletedModelResponse,
  createFrozenNarrativeModelContract,
  type FrozenNarrativeModelContractInput,
  type NarrativeModelGateway,
  type NarrativeModelRequest,
  type NarrativeModelResponse,
  type NarrativeModelTask
} from './model-contract'
import {
  NarrativeWorkflowStore,
  type NarrativeWorkflowRun,
  type StartWorkflowRunInput,
  type WorkflowStep
} from './workflow-store'

export interface StartAutomatedChapterInput {
  runId: string
  novelId: number
  intentId: string
  modelContract: FrozenNarrativeModelContractInput
  maxRepairs: number
  maxStepAttempts: number
  editorialPolicyVersion: number
}

interface ModelStepResult {
  step: WorkflowStep
  response: NarrativeModelResponse
}

const PROTOCOL_FAILURES = new Set<string>([
  'MODEL_CALL_FAILED',
  'MODEL_OUTPUT_EMPTY',
  'MODEL_OUTPUT_TRUNCATED',
  'CHAPTER_CANDIDATE_INVALID',
  'CHAPTER_CANDIDATE_TRUNCATED',
  'CHAPTER_WORD_COUNT_OUT_OF_RANGE',
  'NARRATIVE_PATCH_INVALID',
  'EVIDENCE_SCOPE_MISMATCH',
  'EVIDENCE_RANGE_INVALID',
  'EVIDENCE_HASH_MISMATCH',
  'EDITORIAL_GATE_INCOMPLETE',
  'EDITORIAL_EVIDENCE_AMBIGUOUS'
])

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof NarrativeKernelError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: 'UNEXPECTED_ERROR', message: error.message }
  }
  return { code: 'UNEXPECTED_ERROR', message: String(error) }
}

export class AutomatedChapterRunner {
  readonly pipeline: NarrativeChapterPipeline
  readonly workflows: NarrativeWorkflowStore

  constructor(
    private readonly db: Database.Database,
    private readonly gateway: NarrativeModelGateway
  ) {
    this.pipeline = new NarrativeChapterPipeline(db)
    this.workflows = new NarrativeWorkflowStore(db)
  }

  start(input: StartAutomatedChapterInput): NarrativeWorkflowRun {
    const intent = this.pipeline.loadIntent(input.intentId)
    const state = this.pipeline.loadState(input.novelId)
    if (intent.workId !== input.novelId || intent.baseStateRevision !== state.revision) {
      throw new NarrativeKernelError(
        'CHAPTER_INTENT_STALE',
        '不能为过期或其他小说的章节契约启动自动运行',
        {
          intentWorkId: intent.workId,
          novelId: input.novelId,
          intentRevision: intent.baseStateRevision,
          stateRevision: state.revision
        }
      )
    }
    const runInput: StartWorkflowRunInput = {
      id: input.runId,
      novelId: input.novelId,
      intentId: input.intentId,
      maxRepairs: input.maxRepairs,
      maxStepAttempts: input.maxStepAttempts,
      editorialPolicyVersion: input.editorialPolicyVersion,
      modelContract: createFrozenNarrativeModelContract(input.modelContract)
    }
    return this.workflows.createRun(runInput)
  }

  async runToTerminal(
    runId: string,
    owner = 'narrative-runner',
    leaseMs = 15 * 60 * 1000
  ): Promise<NarrativeWorkflowRun> {
    const existing = this.workflows.loadRun(runId)
    if (existing.status !== 'running') return existing
    let claimed = false
    try {
      let run = this.workflows.claimRun(runId, owner, Date.now(), leaseMs)
      claimed = run.status === 'running'
      for (let transition = 0; transition < 100 && run.status === 'running'; transition += 1) {
        if (run.desiredState === 'cancelled') {
          run.status = 'cancelled'
          this.workflows.saveRun(run)
          break
        }
        run = this.workflows.claimRun(runId, owner, Date.now(), leaseMs)
        try {
          await this.executePhase(run)
        } catch (error) {
          this.handlePhaseFailure(runId, error)
        }
        run = this.workflows.loadRun(runId)
      }
      run = this.workflows.loadRun(runId)
      if (run.status === 'running') {
        run.status = 'blocked'
        run.errorCode = 'WORKFLOW_STATE_INVALID'
        run.errorMessage = '自动章节运行超过最大状态转移次数'
        this.workflows.saveRun(run)
      }
      return this.workflows.loadRun(runId)
    } finally {
      if (claimed) this.workflows.releaseRun(runId, owner)
    }
  }

  private async executePhase(run: NarrativeWorkflowRun): Promise<void> {
    switch (run.currentPhase) {
      case 'generate_candidate':
        await this.generateCandidate(run)
        return
      case 'extract_patch':
        await this.extractPatch(run)
        return
      case 'editorial_review':
        await this.reviewEditorialGate(run)
        return
      case 'revise_candidate':
        await this.reviseCandidate(run)
        return
      case 'commit_chapter':
        this.commitChapter(run)
        return
      case 'completed':
        run.status = 'completed'
        this.workflows.saveRun(run)
        return
    }
  }

  private async generateCandidate(run: NarrativeWorkflowRun): Promise<void> {
    const intent = this.pipeline.loadIntent(run.intentId)
    const state = this.pipeline.loadState(run.novelId)
    const candidateId = `${run.id}:candidate:0`
    const input = {
      intent,
      state,
      expectedCandidateId: candidateId
    }
    const result = await this.modelStep(run, 'generate_candidate', 'chapter_body', input)
    try {
      assertCompletedModelResponse(result.response, 'content')
      this.db.transaction(() => {
        const candidate = this.pipeline.registerCandidate({
          id: candidateId,
          intentId: intent.id,
          content: result.response.content as string,
          generation: {
            source: 'model',
            finishReason: result.response.finishReason,
            completionTokens: result.response.completionTokens,
            modelCallId: result.step.id
          }
        })
        run.candidateId = candidate.id
        run.patchId = undefined
        run.currentPhase = 'extract_patch'
        run.phaseAttempt = 0
        run.errorCode = undefined
        run.errorMessage = undefined
        this.workflows.succeedStep(result.step.id, candidate.id)
        this.workflows.saveRun(run)
      })()
    } catch (error) {
      this.workflows.failStep(result.step.id, errorDetails(error).code, errorDetails(error).message)
      throw error
    }
  }

  private async extractPatch(run: NarrativeWorkflowRun): Promise<void> {
    const intent = this.pipeline.loadIntent(run.intentId)
    const candidate = this.requireCandidate(run)
    const state = this.pipeline.loadState(run.novelId)
    const patchId = `${run.id}:patch:${run.repairCount}`
    const input = {
      intent,
      candidate,
      state,
      expectedPatchId: patchId
    }
    const result = await this.modelStep(run, 'extract_patch', 'narrative_patch', input)
    try {
      assertCompletedModelResponse(result.response, 'structured')
      this.db.transaction(() => {
        const patch = this.pipeline.registerPatch(result.response.structuredOutput)
        if (patch.id !== patchId) {
          throw new NarrativeKernelError(
            'NARRATIVE_PATCH_INVALID',
            '模型补丁 ID 与执行合同不一致',
            { expectedPatchId: patchId, actualPatchId: patch.id }
          )
        }
        run.patchId = patch.id
        run.currentPhase = 'editorial_review'
        run.editorialGateIndex = 0
        run.phaseAttempt = 0
        run.errorCode = undefined
        run.errorMessage = undefined
        this.workflows.succeedStep(result.step.id, patch.id)
        this.workflows.saveRun(run)
      })()
    } catch (error) {
      this.workflows.failStep(result.step.id, errorDetails(error).code, errorDetails(error).message)
      throw error
    }
  }

  private async reviewEditorialGate(run: NarrativeWorkflowRun): Promise<void> {
    const gateType = REQUIRED_EDITORIAL_GATES[run.editorialGateIndex]
    if (!gateType) {
      run.currentPhase = 'commit_chapter'
      run.phaseAttempt = 0
      this.workflows.saveRun(run)
      return
    }
    const intent = this.pipeline.loadIntent(run.intentId)
    const candidate = this.requireCandidate(run)
    const input = { intent, candidate, gateType }
    const stepKey = `editorial_review:${gateType}`
    const result = await this.modelStep(run, stepKey, 'editorial_gate', input)
    try {
      assertCompletedModelResponse(result.response, 'structured')
      this.db.transaction(() => {
        const parsed = parseEditorialGateOutput({
          id: `${run.id}:gate:${run.repairCount}:${gateType}`,
          candidate,
          gateType,
          policyVersion: run.editorialPolicyVersion,
          value: result.response.structuredOutput
        })
        const gate = this.pipeline.recordEditorialGate(parsed)
        this.workflows.succeedStep(result.step.id, gate.id)
        if (gate.status === 'failed') {
          this.transitionToRevision(run, 'EDITORIAL_GATE_FAILED', gate.report)
        } else {
          run.editorialGateIndex += 1
          run.phaseAttempt = 0
          run.errorCode = undefined
          run.errorMessage = undefined
          if (run.editorialGateIndex >= REQUIRED_EDITORIAL_GATES.length) {
            run.currentPhase = 'commit_chapter'
          }
        }
        this.workflows.saveRun(run)
      })()
    } catch (error) {
      this.workflows.failStep(result.step.id, errorDetails(error).code, errorDetails(error).message)
      throw error
    }
  }

  private async reviseCandidate(run: NarrativeWorkflowRun): Promise<void> {
    const intent = this.pipeline.loadIntent(run.intentId)
    const parent = this.requireCandidate(run)
    const candidateId = `${run.id}:candidate:${run.repairCount + 1}`
    const input = {
      intent,
      candidate: parent,
      repair: { code: run.errorCode, message: run.errorMessage },
      expectedCandidateId: candidateId
    }
    const result = await this.modelStep(run, 'revise_candidate', 'chapter_revision', input)
    try {
      assertCompletedModelResponse(result.response, 'content')
      this.db.transaction(() => {
        const candidate = this.pipeline.registerCandidate({
          id: candidateId,
          intentId: intent.id,
          parentCandidateId: parent.id,
          content: result.response.content as string,
          generation: {
            source: 'revision',
            finishReason: result.response.finishReason,
            completionTokens: result.response.completionTokens,
            modelCallId: result.step.id
          }
        })
        run.candidateId = candidate.id
        run.patchId = undefined
        run.repairCount += 1
        run.currentPhase = 'extract_patch'
        run.editorialGateIndex = 0
        run.phaseAttempt = 0
        run.errorCode = undefined
        run.errorMessage = undefined
        this.workflows.succeedStep(result.step.id, candidate.id)
        this.workflows.saveRun(run)
      })()
    } catch (error) {
      this.workflows.failStep(result.step.id, errorDetails(error).code, errorDetails(error).message)
      throw error
    }
  }

  private commitChapter(run: NarrativeWorkflowRun): void {
    const candidate = this.requireCandidate(run)
    if (!run.patchId) {
      throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', '提交阶段缺少叙事补丁')
    }
    const inputHash = canonicalHash({
      intentId: run.intentId,
      candidateId: candidate.id,
      patchId: run.patchId,
      policyVersion: run.editorialPolicyVersion
    })
    const step = this.workflows.beginStep({
      runId: run.id,
      stepKey: 'commit_chapter',
      inputHash,
      attemptNo: 1
    })
    try {
      this.db.transaction(() => {
        const state = this.pipeline.commitCandidate({
          intentId: run.intentId,
          candidateId: candidate.id,
          patchId: run.patchId as string,
          commitId: `${run.id}:commit`,
          chapterVersionId: `${run.id}:chapter-version`,
          editorialPolicyVersion: run.editorialPolicyVersion
        })
        run.currentPhase = 'completed'
        run.status = 'completed'
        run.phaseAttempt = 0
        run.errorCode = undefined
        run.errorMessage = undefined
        this.workflows.succeedStep(step.id, `state:${state.revision}:${state.stateHash}`)
        this.workflows.saveRun(run)
      })()
    } catch (error) {
      this.workflows.failStep(step.id, errorDetails(error).code, errorDetails(error).message)
      throw error
    }
  }

  private async modelStep(
    run: NarrativeWorkflowRun,
    stepKey: string,
    task: NarrativeModelTask,
    input: Readonly<Record<string, unknown>>
  ): Promise<ModelStepResult> {
    const inputHash = canonicalHash({
      task,
      input,
      contractHash: run.modelContract.contractHash
    })
    const attemptNo = run.phaseAttempt + 1
    const step = this.workflows.beginStep({
      runId: run.id,
      stepKey,
      inputHash,
      attemptNo
    })
    const requestId = `${step.id}:model`
    const cached = this.workflows.loadCompletedModelCall(
      requestId,
      task,
      run.modelContract
    )
    if (cached) return { step, response: cached }

    const request: NarrativeModelRequest = {
      requestId,
      task,
      contract: run.modelContract,
      input
    }
    this.workflows.beginModelCall(run.id, step.id, request)
    let response: NarrativeModelResponse
    try {
      response = await this.gateway.invoke(request)
    } catch (error) {
      response = {
        status: 'failed',
        promptTokens: 0,
        completionTokens: 0,
        reasoningLength: 0,
        durationMs: 0,
        errorCode: 'MODEL_TRANSPORT_ERROR',
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    }
    this.workflows.finishModelCall(requestId, response)
    return { step, response }
  }

  private handlePhaseFailure(runId: string, error: unknown): void {
    const run = this.workflows.loadRun(runId)
    const failure = errorDetails(error)
    if (
      failure.code === 'MODEL_CALL_OUTCOME_UNKNOWN' ||
      failure.code === 'STATE_REVISION_STALE' ||
      failure.code === 'CHAPTER_INTENT_STALE' ||
      run.currentPhase === 'commit_chapter'
    ) {
      this.block(run, failure.code, failure.message)
      return
    }

    const protocolFailure = PROTOCOL_FAILURES.has(failure.code)
    if (protocolFailure || run.currentPhase === 'generate_candidate' || run.currentPhase === 'revise_candidate') {
      const attemptsUsed = run.phaseAttempt + 1
      if (attemptsUsed >= run.maxStepAttempts) {
        this.block(
          run,
          'MODEL_PROTOCOL_EXHAUSTED',
          `${run.currentPhase} 连续 ${attemptsUsed} 次未满足固定模型协议：${failure.message}`
        )
      } else {
        run.phaseAttempt = attemptsUsed
        run.errorCode = failure.code
        run.errorMessage = failure.message
        this.workflows.saveRun(run)
      }
      return
    }
    this.transitionToRevision(run, failure.code, failure.message)
    this.workflows.saveRun(run)
  }

  private transitionToRevision(
    run: NarrativeWorkflowRun,
    code: string,
    message: string
  ): void {
    if (run.repairCount >= run.maxRepairs) {
      this.block(
        run,
        'REPAIR_BUDGET_EXHAUSTED',
        `章节在 ${run.maxRepairs} 次修订后仍未通过：${message}`
      )
      return
    }
    run.currentPhase = 'revise_candidate'
    run.phaseAttempt = 0
    run.errorCode = code
    run.errorMessage = message
  }

  private block(run: NarrativeWorkflowRun, code: string, message: string): void {
    run.status = 'blocked'
    run.errorCode = code
    run.errorMessage = message
    this.workflows.saveRun(run)
  }

  private requireCandidate(run: NarrativeWorkflowRun): ChapterCandidate {
    if (!run.candidateId) {
      throw new NarrativeKernelError(
        'WORKFLOW_STATE_INVALID',
        `${run.currentPhase} 阶段缺少候选正文`,
        { runId: run.id }
      )
    }
    return this.pipeline.loadCandidate(run.candidateId)
  }
}
