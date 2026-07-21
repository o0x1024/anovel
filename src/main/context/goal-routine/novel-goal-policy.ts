export const MAX_AUTO_NOVEL_REPAIR_CHAPTERS = 8
export const MAX_NOVEL_PHASE_FAILURES = 6
export const MAX_NOVEL_REPAIR_STALLS = 5

export function isTerminalNovelRepairError(errorCode: string): boolean {
  return errorCode === 'REPAIR_BOUNDARY' || errorCode === 'REPAIR_STALL'
}

function normalizedNovelFailureKind(message: string): string {
  if (/timeout|timed out|超时/i.test(message)) return 'timeout'
  if (/finishReason=length|VOLUME_OUTPUT_TRUNCATED|Unterminated string|Unexpected end of JSON|截断/i.test(message)) {
    return 'truncated'
  }
  if (/解析失败|缺少 issues|缺少 requiredOutcome|不是合法 JSON|OUTPUT_INVALID/i.test(message)) return 'output_contract'
  return 'stable'
}

/**
 * 熔断签名只能由稳定的阶段、子任务和错误码组成，禁止混入模型自由文本。
 * 否则模型每次换一种问题表述都会把连续失败计数重置为 1。
 */
export function novelPhaseFailureSignature(phase: string, errorCode: string, message: string): string {
  let stage = 'phase'
  if (phase === 'generate_beats') {
    const window = message.match(/第\s*(\d+)\s*-\s*(\d+)\s*章窗口门禁/)
    if (window) stage = `volume_gate_window_${window[1]}_${window[2]}`
    else if (/只读聚合门禁/.test(message)) stage = 'volume_gate_aggregate'
    else if (/定点修复/.test(message)) stage = 'volume_gate_repair'
    else stage = 'chapter_contract_generation'
  } else if (phase === 'generate_volumes') {
    stage = 'volume_contract_generation'
  } else if (phase === 'draft_body') {
    if (/章节执行合同|CONTRACT_INVALID|合同冲突/.test(message)) stage = 'chapter_contract'
    else if (errorCode === 'EVALUATOR_PROTOCOL' || /评估器.*(?:证据协议|逐项验证|精确证据)|门禁证据协议/.test(message)) stage = 'execution_evaluator'
    else if (/泛白类模板反应|泛白类身体反应/.test(message)) stage = 'anti_ai_repair'
    else if (/章节情节点覆盖|章节执行门禁未通过|章际衔接/.test(message)) stage = 'execution_gate'
    else if (/模式指纹|chapter_pattern|MISSING_PATTERN_FINGERPRINT/.test(message)) stage = 'pattern_fingerprint'
    else if (/叙事记忆|state_facts|正文证据/.test(message)) stage = 'memory_extraction'
    else if (/质量与情绪|质量总分|AI句式|对话密度|句长波动|字数达标/.test(message)) stage = 'body_acceptance'
    else if (/资源数值门禁|资源约束/.test(message)) stage = 'resource_gate'
    else if (/一致性门禁|跨章状态|状态\/模式门禁/.test(message)) stage = 'systemic_gate'
    else stage = 'body_generation'
  }
  return `${phase}:${stage}:${errorCode}:${normalizedNovelFailureKind(message)}`
}

export function isNovelChapterReadyForTransition(input: {
  qualityReady: boolean
  emotionReady: boolean
  patternFingerprintReady: boolean
}): boolean {
  return input.qualityReady && input.emotionReady && input.patternFingerprintReady
}

export interface NovelPolicyChapter {
  id: number
  volume_id: number
}

/**
 * 自动修复只能触及全书当前尾部的小窗口。
 * 旧章节已经被后续正文依赖，不能因为一次不稳定的 AI 评分而级联重写。
 */
export function capNovelAutomaticRepairTargets(
  targetChapterIds: number[],
  chapters: NovelPolicyChapter[],
  maxChapters = MAX_AUTO_NOVEL_REPAIR_CHAPTERS
): number[] {
  if (targetChapterIds.length === 0 || chapters.length === 0 || maxChapters <= 0) return []
  const requested = new Set(targetChapterIds)
  return chapters
    .slice(-maxChapters)
    .filter(chapter => requested.has(chapter.id))
    .map(chapter => chapter.id)
}

export function shouldPauseForReadOnlyNovelAudit(input: {
  planComplete: boolean
  contentComplete: boolean
  met: boolean
}): boolean {
  return input.planComplete && input.contentComplete && !input.met
}

export function shouldRecoverNovelChapterExecutionProtocol(input: {
  resume: boolean
  phase: string
  savedVersion: number | undefined
  currentVersion: number
}): boolean {
  return input.resume
    && input.phase === 'draft_body'
    && input.savedVersion !== input.currentVersion
}

export function nextPhaseAfterNovelOutlineCheckpoint(input: {
  volumeReadyForDraft: boolean
  titleHookApplied: boolean
  allOutlinesComplete: boolean
}): 'generate_beats' | 'generate_title_hook' | 'draft_body' {
  if (!input.volumeReadyForDraft && !input.allOutlinesComplete) return 'generate_beats'
  return input.titleHookApplied ? 'draft_body' : 'generate_title_hook'
}

export interface ReusableNovelExecutionCandidate {
  version_number: number
  outline: string | null
  content: string | null
  word_count: number
  model_type: string | null
  generation_round?: number
  snapshot_json: string | null
}

function isLegacyEvidenceOnlyCandidate(candidate: ReusableNovelExecutionCandidate): boolean {
  if (candidate.model_type !== 'novel_execution_candidate' || !candidate.snapshot_json) return false
  try {
    const snapshot = JSON.parse(candidate.snapshot_json) as {
      gate?: { blockers?: unknown }
    }
    const blockers = snapshot.gate?.blockers
    return Array.isArray(blockers)
      && blockers.length > 0
      && blockers.every(blocker =>
        typeof blocker === 'string'
        && blocker.includes('评估器给出的证据不是正文精确原句')
      )
  } catch {
    return false
  }
}

function novelCandidateProgress(candidate: ReusableNovelExecutionCandidate): {
  coverage: number
  violations: number
} {
  if (!candidate.snapshot_json) return { coverage: 0, violations: 0 }
  try {
    const snapshot = JSON.parse(candidate.snapshot_json) as {
      gate?: { coverage?: unknown; forbiddenViolations?: unknown; blockers?: unknown }
      evaluatorAttempts?: unknown
    }
    const gates = [snapshot.gate]
    if (Array.isArray(snapshot.evaluatorAttempts)) {
      for (const attempt of snapshot.evaluatorAttempts) {
        if (attempt && typeof attempt === 'object') gates.push(attempt as typeof snapshot.gate)
      }
    }
    let coverage = 0
    let violations = 0
    for (const gate of gates) {
      if (!gate) continue
      if (Array.isArray(gate.coverage)) {
        const score = gate.coverage.reduce((sum, row) => {
          if (!row || typeof row !== 'object') return sum
          const verdict = String((row as { verdict?: unknown }).verdict ?? '')
          return sum + (verdict === 'covered' ? 2 : verdict === 'partial' ? 1 : 0)
        }, 0)
        coverage = Math.max(coverage, score)
      }
      violations = Math.max(
        violations,
        Array.isArray(gate.forbiddenViolations) ? gate.forbiddenViolations.length : 0
      )
    }
    return { coverage, violations }
  } catch {
    return { coverage: 0, violations: 0 }
  }
}

/**
 * 恢复时沿着章节修复前沿继续：修复轮次优先，其次是已覆盖验收项、越界风险、
 * 字数范围和版本新旧。不能仅按字数距离退回更早、语义进度更低的候选。
 */
export function selectReusableNovelExecutionCandidate(
  candidates: ReusableNovelExecutionCandidate[],
  input: {
    outline: string | null | undefined
    wordTarget: number
    wordMin: number
    wordMax: number
  }
): ReusableNovelExecutionCandidate | undefined {
  return candidates
    .filter(candidate => Boolean(candidate.content?.trim()))
    .filter(candidate => !candidate.outline || candidate.outline === input.outline)
    .filter(candidate =>
      candidate.model_type === 'novel_gate_evidence'
      || candidate.model_type === 'novel_execution_candidate'
      || candidate.model_type === 'novel_scene_complete'
      || isLegacyEvidenceOnlyCandidate(candidate)
    )
    .sort((left, right) => {
      const round = (right.generation_round ?? 0) - (left.generation_round ?? 0)
      if (round) return round
      const leftProgress = novelCandidateProgress(left)
      const rightProgress = novelCandidateProgress(right)
      if (leftProgress.coverage !== rightProgress.coverage) return rightProgress.coverage - leftProgress.coverage
      if (leftProgress.violations !== rightProgress.violations) return leftProgress.violations - rightProgress.violations
      const leftInRange = left.word_count >= input.wordMin && left.word_count <= input.wordMax
      const rightInRange = right.word_count >= input.wordMin && right.word_count <= input.wordMax
      if (leftInRange !== rightInRange) return leftInRange ? -1 : 1
      const version = right.version_number - left.version_number
      if (version) return version
      return Math.abs(left.word_count - input.wordTarget) - Math.abs(right.word_count - input.wordTarget)
    })[0]
}
