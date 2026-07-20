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

export function nextPhaseAfterNovelOutlineCheckpoint(input: {
  volumeReadyForDraft: boolean
  titleHookApplied: boolean
  allOutlinesComplete: boolean
}): 'generate_beats' | 'generate_title_hook' | 'draft_body' {
  if (!input.volumeReadyForDraft && !input.allOutlinesComplete) return 'generate_beats'
  return input.titleHookApplied ? 'draft_body' : 'generate_title_hook'
}
