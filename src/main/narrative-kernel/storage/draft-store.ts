import type Database from 'better-sqlite3'
import type {
  ChapterCandidate,
  ChapterIntent,
  EditorialGateResult,
  NarrativePatch
} from '../chapter-contracts'
import { assertNarrativeKernel } from '../errors'
import { canonicalHash, canonicalJson, sha256 } from '../hash'
import { ensureNarrativeEventStoreSchema } from './schema'

interface JsonRow {
  payload: string
  persisted_hash: string
}

export interface PipelineCommitRecord {
  commitId: string
  intentId: string
  candidateId: string
  patchId: string
  intentHash: string
  candidateHash: string
  patchHash: string
  editorialPolicyVersion: number
}

function intentPayload(intent: ChapterIntent): Omit<ChapterIntent, 'contractHash'> {
  const { contractHash: _contractHash, ...payload } = intent
  return payload
}

function patchPayload(patch: NarrativePatch): Omit<NarrativePatch, 'patchHash'> {
  const { patchHash: _patchHash, ...payload } = patch
  return payload
}

function gatePayload(result: EditorialGateResult): Omit<EditorialGateResult, 'resultHash'> {
  const { resultHash: _resultHash, ...payload } = result
  return payload
}

export class NarrativeDraftStore {
  constructor(private readonly db: Database.Database) {
    ensureNarrativeEventStoreSchema(db)
  }

  saveIntent(intent: ChapterIntent): void {
    assertNarrativeKernel(
      canonicalHash(intentPayload(intent)) === intent.contractHash,
      'PIPELINE_ARTIFACT_HASH_MISMATCH',
      '章节契约哈希无效',
      { intentId: intent.id }
    )
    this.db.prepare(`
      INSERT INTO narrative_chapter_intents (
        id, novel_id, chapter_ordinal, base_state_revision,
        protocol_version, intent_json, contract_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      intent.id,
      intent.workId,
      intent.chapterOrdinal,
      intent.baseStateRevision,
      intent.protocolVersion,
      canonicalJson(intent),
      intent.contractHash
    )
  }

  loadIntent(intentId: string): ChapterIntent {
    const row = this.db.prepare(`
      SELECT intent_json AS payload, contract_hash AS persisted_hash
      FROM narrative_chapter_intents
      WHERE id = ?
    `).get(intentId) as JsonRow | undefined
    assertNarrativeKernel(
      row,
      'CHAPTER_INTENT_INVALID',
      `章节契约不存在：${intentId}`,
      { intentId }
    )
    const intent = JSON.parse(row.payload) as ChapterIntent
    assertNarrativeKernel(
      intent.contractHash === row.persisted_hash &&
        canonicalHash(intentPayload(intent)) === row.persisted_hash,
      'PIPELINE_ARTIFACT_HASH_MISMATCH',
      '持久化章节契约哈希不一致',
      { intentId }
    )
    return intent
  }

  saveCandidate(candidate: ChapterCandidate): void {
    assertNarrativeKernel(
      sha256(candidate.content) === candidate.contentHash,
      'PIPELINE_ARTIFACT_HASH_MISMATCH',
      '候选正文哈希无效',
      { candidateId: candidate.id }
    )
    this.db.prepare(`
      INSERT INTO narrative_chapter_candidates (
        id, intent_id, parent_candidate_id, source_kind,
        content, content_hash, word_count, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.id,
      candidate.intentId,
      candidate.parentCandidateId ?? null,
      candidate.generation.source,
      candidate.content,
      candidate.contentHash,
      candidate.wordCount,
      canonicalJson(candidate.generation)
    )
  }

  loadCandidate(candidateId: string): ChapterCandidate {
    const row = this.db.prepare(`
      SELECT id, intent_id, parent_candidate_id, content,
             content_hash, word_count, metadata_json
      FROM narrative_chapter_candidates
      WHERE id = ?
    `).get(candidateId) as {
      id: string
      intent_id: string
      parent_candidate_id: string | null
      content: string
      content_hash: string
      word_count: number
      metadata_json: string
    } | undefined
    assertNarrativeKernel(
      row,
      'CHAPTER_CANDIDATE_INVALID',
      `候选正文不存在：${candidateId}`,
      { candidateId }
    )
    assertNarrativeKernel(
      sha256(row.content) === row.content_hash,
      'PIPELINE_ARTIFACT_HASH_MISMATCH',
      '持久化候选正文哈希不一致',
      { candidateId }
    )
    return {
      id: row.id,
      intentId: row.intent_id,
      ...(row.parent_candidate_id ? { parentCandidateId: row.parent_candidate_id } : {}),
      content: row.content,
      contentHash: row.content_hash,
      wordCount: row.word_count,
      generation: JSON.parse(row.metadata_json)
    }
  }

  savePatch(patch: NarrativePatch): void {
    assertNarrativeKernel(
      canonicalHash(patchPayload(patch)) === patch.patchHash,
      'PIPELINE_ARTIFACT_HASH_MISMATCH',
      '叙事补丁哈希无效',
      { patchId: patch.id }
    )
    this.db.prepare(`
      INSERT INTO narrative_patch_candidates (
        id, intent_id, candidate_id, base_state_revision,
        protocol_version, patch_json, patch_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      patch.id,
      patch.intentId,
      patch.candidateId,
      patch.baseStateRevision,
      patch.protocolVersion,
      canonicalJson(patch),
      patch.patchHash
    )
  }

  loadPatch(patchId: string): NarrativePatch {
    const row = this.db.prepare(`
      SELECT patch_json AS payload, patch_hash AS persisted_hash
      FROM narrative_patch_candidates
      WHERE id = ?
    `).get(patchId) as JsonRow | undefined
    assertNarrativeKernel(
      row,
      'NARRATIVE_PATCH_INVALID',
      `叙事补丁不存在：${patchId}`,
      { patchId }
    )
    const patch = JSON.parse(row.payload) as NarrativePatch
    assertNarrativeKernel(
      patch.patchHash === row.persisted_hash &&
        canonicalHash(patchPayload(patch)) === row.persisted_hash,
      'PIPELINE_ARTIFACT_HASH_MISMATCH',
      '持久化叙事补丁哈希不一致',
      { patchId }
    )
    return patch
  }

  saveEditorialGate(result: EditorialGateResult): void {
    assertNarrativeKernel(
      sha256(result.report) === result.reportHash,
      'PIPELINE_ARTIFACT_HASH_MISMATCH',
      '文学门报告哈希无效',
      { gateId: result.id, gateType: result.gateType }
    )
    assertNarrativeKernel(
      canonicalHash(gatePayload(result)) === result.resultHash,
      'PIPELINE_ARTIFACT_HASH_MISMATCH',
      '文学门结果哈希无效',
      { gateId: result.id, gateType: result.gateType }
    )
    const save = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO narrative_editorial_gate_results (
          id, candidate_id, gate_type, policy_version,
          status, score, report, report_hash, result_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.id,
        result.candidateId,
        result.gateType,
        result.policyVersion,
        result.status,
        result.score ?? null,
        result.report,
        result.reportHash,
        result.resultHash
      )
      const insertEvidence = this.db.prepare(`
        INSERT INTO narrative_editorial_evidence_spans (
          id, gate_result_id, candidate_id, start_offset, end_offset, quote_hash
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      result.evidence.forEach((evidence, index) => {
        insertEvidence.run(
          `${result.id}:evidence:${index + 1}`,
          result.id,
          evidence.candidateId,
          evidence.startOffset,
          evidence.endOffset,
          evidence.quoteHash
        )
      })
    })
    save()
  }

  loadEditorialGates(candidateId: string, policyVersion: number): EditorialGateResult[] {
    const rows = this.db.prepare(`
      SELECT id, candidate_id, gate_type, policy_version,
             status, score, report, report_hash, result_hash
      FROM narrative_editorial_gate_results
      WHERE candidate_id = ? AND policy_version = ?
      ORDER BY gate_type ASC
    `).all(candidateId, policyVersion) as Array<{
      id: string
      candidate_id: string
      gate_type: EditorialGateResult['gateType']
      policy_version: number
      status: EditorialGateResult['status']
      score: number | null
      report: string
      report_hash: string
      result_hash: string
    }>
    const readEvidence = this.db.prepare(`
      SELECT candidate_id, start_offset, end_offset, quote_hash
      FROM narrative_editorial_evidence_spans
      WHERE gate_result_id = ?
      ORDER BY id ASC
    `)
    return rows.map(row => {
      assertNarrativeKernel(
        sha256(row.report) === row.report_hash,
        'PIPELINE_ARTIFACT_HASH_MISMATCH',
        '持久化文学门报告哈希不一致',
        { gateId: row.id, gateType: row.gate_type }
      )
      const evidence = (readEvidence.all(row.id) as Array<{
        candidate_id: string
        start_offset: number
        end_offset: number
        quote_hash: string
      }>).map(item => ({
        candidateId: item.candidate_id,
        startOffset: item.start_offset,
        endOffset: item.end_offset,
        quoteHash: item.quote_hash
      }))
      const result: EditorialGateResult = {
        id: row.id,
        candidateId: row.candidate_id,
        gateType: row.gate_type,
        policyVersion: row.policy_version,
        status: row.status,
        ...(row.score == null ? {} : { score: row.score }),
        report: row.report,
        reportHash: row.report_hash,
        evidence,
        resultHash: row.result_hash
      }
      assertNarrativeKernel(
        canonicalHash(gatePayload(result)) === result.resultHash,
        'PIPELINE_ARTIFACT_HASH_MISMATCH',
        '持久化文学门结果哈希不一致',
        { gateId: row.id, gateType: row.gate_type }
      )
      return result
    })
  }

  recordPipelineCommit(record: PipelineCommitRecord): void {
    this.db.prepare(`
      INSERT INTO narrative_pipeline_commits (
        commit_id, intent_id, candidate_id, patch_id,
        intent_hash, candidate_hash, patch_hash, editorial_policy_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.commitId,
      record.intentId,
      record.candidateId,
      record.patchId,
      record.intentHash,
      record.candidateHash,
      record.patchHash,
      record.editorialPolicyVersion
    )
  }
}
