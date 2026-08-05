import type Database from 'better-sqlite3'
import {
  createChapterCandidate,
  createChapterIntent,
  createEditorialGateResult,
  type ChapterCandidate,
  type ChapterCandidateInput,
  type ChapterIntent,
  type ChapterIntentInput,
  type EditorialGateResult,
  type NarrativePatch
} from './chapter-contracts'
import type { NarrativeState } from './domain'
import {
  assertEditorialGatesPassed,
  validateEditorialGateResult
} from './editorial-gates'
import { assertNarrativeKernel } from './errors'
import {
  prepareNarrativeCommit,
  validateNarrativePatch,
  type ValidatedNarrativePatch
} from './patch-validator'
import { parseNarrativePatch } from './patch-parser'
import { NarrativeDraftStore } from './storage/draft-store'
import {
  NarrativeEventStore,
  type CommittedNarrativeChapter
} from './storage/event-store'

export interface CommitChapterCandidateInput {
  intentId: string
  candidateId: string
  patchId: string
  commitId: string
  chapterVersionId: string
  editorialPolicyVersion: number
}

export class NarrativeChapterPipeline {
  private readonly events: NarrativeEventStore
  private readonly drafts: NarrativeDraftStore

  constructor(private readonly db: Database.Database) {
    this.events = new NarrativeEventStore(db)
    this.drafts = new NarrativeDraftStore(db)
  }

  createNovel(input: { id: number; title: string }): NarrativeState {
    return this.events.createNovel(input)
  }

  createNovelWithGeneratedId(title: string): NarrativeState {
    return this.events.createNovelWithGeneratedId(title)
  }

  listNovels() {
    return this.events.listNovels()
  }

  registerIntent(input: ChapterIntentInput): ChapterIntent {
    const state = this.events.loadState(input.workId)
    assertNarrativeKernel(
      state.revision === input.baseStateRevision,
      'CHAPTER_INTENT_STALE',
      '不能注册基于过期权威状态的章节契约',
      { currentRevision: state.revision, baseStateRevision: input.baseStateRevision }
    )
    const expectedChapterOrdinal = this.events.listCommittedChapters(input.workId).length + 1
    assertNarrativeKernel(
      input.chapterOrdinal === expectedChapterOrdinal,
      'CHAPTER_INTENT_INVALID',
      '章节契约必须只创建下一章，不能跳章或重写已提交章节',
      { expectedChapterOrdinal, actualChapterOrdinal: input.chapterOrdinal }
    )
    const intent = createChapterIntent(input)
    this.drafts.saveIntent(intent)
    return intent
  }

  registerCandidate(input: ChapterCandidateInput): ChapterCandidate {
    const intent = this.drafts.loadIntent(input.intentId)
    this.assertIntentCurrent(intent)
    if (input.parentCandidateId) {
      const parent = this.drafts.loadCandidate(input.parentCandidateId)
      assertNarrativeKernel(
        parent.intentId === input.intentId,
        'CHAPTER_CANDIDATE_INVALID',
        '父候选不属于同一章节契约',
        { candidateId: input.id, parentCandidateId: input.parentCandidateId }
      )
    }
    const candidate = createChapterCandidate(intent, input)
    this.drafts.saveCandidate(candidate)
    return candidate
  }

  registerPatch(value: unknown): NarrativePatch {
    const patch = parseNarrativePatch(value)
    const intent = this.drafts.loadIntent(patch.intentId)
    const candidate = this.drafts.loadCandidate(patch.candidateId)
    const state = this.assertIntentCurrent(intent)
    validateNarrativePatch({ intent, candidate, patch, state })
    this.drafts.savePatch(patch)
    return patch
  }

  recordEditorialGate(
    input: Omit<EditorialGateResult, 'reportHash' | 'resultHash'>
  ): EditorialGateResult {
    const candidate = this.drafts.loadCandidate(input.candidateId)
    const intent = this.drafts.loadIntent(candidate.intentId)
    this.assertIntentCurrent(intent)
    const result = createEditorialGateResult(input)
    validateEditorialGateResult(candidate, result)
    this.drafts.saveEditorialGate(result)
    return result
  }

  validatePatch(input: {
    intentId: string
    candidateId: string
    patchId: string
  }): ValidatedNarrativePatch {
    const intent = this.drafts.loadIntent(input.intentId)
    const candidate = this.drafts.loadCandidate(input.candidateId)
    const patch = this.drafts.loadPatch(input.patchId)
    const state = this.events.loadState(intent.workId)
    return validateNarrativePatch({ intent, candidate, patch, state })
  }

  commitCandidate(input: CommitChapterCandidateInput): NarrativeState {
    const commit = this.db.transaction(() => {
      const intent = this.drafts.loadIntent(input.intentId)
      const candidate = this.drafts.loadCandidate(input.candidateId)
      const patch = this.drafts.loadPatch(input.patchId)
      const state = this.events.loadState(intent.workId)
      const validated = validateNarrativePatch({ intent, candidate, patch, state })
      const gates = this.drafts.loadEditorialGates(
        candidate.id,
        input.editorialPolicyVersion
      )
      assertEditorialGatesPassed(candidate, gates, input.editorialPolicyVersion)
      const narrativeCommit = prepareNarrativeCommit({
        intent,
        candidate,
        patch,
        validated,
        commitId: input.commitId,
        chapterVersionId: input.chapterVersionId
      })
      const next = this.events.appendChapterCommit({
        commit: narrativeCommit,
        content: candidate.content
      })
      assertNarrativeKernel(
        next.stateHash === validated.previewStateHash,
        'STATE_HASH_MISMATCH',
        '正式章节提交结果与补丁试运行状态不一致',
        {
          commitId: narrativeCommit.id,
          previewStateHash: validated.previewStateHash,
          committedStateHash: next.stateHash
        }
      )
      this.drafts.recordPipelineCommit({
        commitId: narrativeCommit.id,
        intentId: intent.id,
        candidateId: candidate.id,
        patchId: patch.id,
        intentHash: intent.contractHash,
        candidateHash: candidate.contentHash,
        patchHash: patch.patchHash,
        editorialPolicyVersion: input.editorialPolicyVersion
      })
      return next
    })
    return commit()
  }

  loadState(workId: number): NarrativeState {
    return this.events.loadState(workId)
  }

  loadIntent(intentId: string): ChapterIntent {
    return this.drafts.loadIntent(intentId)
  }

  loadCandidate(candidateId: string): ChapterCandidate {
    return this.drafts.loadCandidate(candidateId)
  }

  integrityCheck(): string[] {
    return this.events.integrityCheck()
  }

  loadNovelTitle(workId: number): string {
    return this.events.loadNovelTitle(workId)
  }

  listCommittedChapters(workId: number): CommittedNarrativeChapter[] {
    return this.events.listCommittedChapters(workId)
  }

  private assertIntentCurrent(intent: ChapterIntent): NarrativeState {
    const state = this.events.loadState(intent.workId)
    assertNarrativeKernel(
      state.revision === intent.baseStateRevision,
      'CHAPTER_INTENT_STALE',
      '章节契约不再基于当前权威状态',
      {
        intentId: intent.id,
        currentRevision: state.revision,
        baseStateRevision: intent.baseStateRevision
      }
    )
    return state
  }
}
