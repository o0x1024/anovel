export type NarrativeKernelErrorCode =
  | 'STATE_REVISION_STALE'
  | 'STATE_HASH_MISMATCH'
  | 'CONTENT_HASH_MISMATCH'
  | 'COMMIT_HASH_MISMATCH'
  | 'EVENT_HASH_MISMATCH'
  | 'COMMIT_REVISION_INVALID'
  | 'EVENT_ID_DUPLICATE'
  | 'ENTITY_ALREADY_EXISTS'
  | 'ENTITY_REFERENCE_UNKNOWN'
  | 'ENTITY_REFERENCE_AMBIGUOUS'
  | 'ARTIFACT_PROVENANCE_CONFLICT'
  | 'ARTIFACT_NOT_OWNED'
  | 'ARTIFACT_ALREADY_RETIRED'
  | 'ARTIFACT_QUANTITY_INVALID'
  | 'ARTIFACT_QUANTITY_INSUFFICIENT'
  | 'KNOWLEDGE_CLAIM_UNKNOWN'
  | 'KNOWLEDGE_PRECONDITION_FAILED'
  | 'EVIDENCE_SCOPE_MISMATCH'
  | 'EVIDENCE_RANGE_INVALID'
  | 'EVIDENCE_HASH_MISMATCH'
  | 'STREAM_ALREADY_EXISTS'
  | 'STREAM_NOT_FOUND'
  | 'CHAPTER_INTENT_INVALID'
  | 'CHAPTER_INTENT_STALE'
  | 'CHAPTER_CANDIDATE_INVALID'
  | 'CHAPTER_CANDIDATE_TRUNCATED'
  | 'CHAPTER_WORD_COUNT_OUT_OF_RANGE'
  | 'NARRATIVE_PATCH_INVALID'
  | 'PATCH_REQUIRED_EVENT_MISSING'
  | 'PATCH_FORBIDDEN_EVENT_PRESENT'
  | 'PATCH_ENTITY_NOT_ALLOWED'
  | 'EDITORIAL_GATE_INCOMPLETE'
  | 'EDITORIAL_GATE_FAILED'
  | 'PIPELINE_ARTIFACT_HASH_MISMATCH'
  | 'MODEL_CALL_FAILED'
  | 'MODEL_OUTPUT_EMPTY'
  | 'MODEL_OUTPUT_TRUNCATED'
  | 'MODEL_PROTOCOL_EXHAUSTED'
  | 'MODEL_CALL_OUTCOME_UNKNOWN'
  | 'EDITORIAL_EVIDENCE_AMBIGUOUS'
  | 'WORKFLOW_RUN_NOT_FOUND'
  | 'WORKFLOW_LEASE_UNAVAILABLE'
  | 'WORKFLOW_STATE_INVALID'
  | 'REPAIR_BUDGET_EXHAUSTED'
  | 'PUBLICATION_NOT_READY'

export class NarrativeKernelError extends Error {
  readonly code: NarrativeKernelErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: NarrativeKernelErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message)
    this.name = 'NarrativeKernelError'
    this.code = code
    this.details = details
  }
}

export function assertNarrativeKernel(
  condition: unknown,
  code: NarrativeKernelErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): asserts condition {
  if (!condition) {
    throw new NarrativeKernelError(code, message, details)
  }
}
