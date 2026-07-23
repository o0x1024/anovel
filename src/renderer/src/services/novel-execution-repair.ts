export interface NovelExecutionGateResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
  execution?: {
    passed: boolean
    coverage: Array<{
      event: string
      verdict: 'covered' | 'partial' | 'missing'
      evidence: string
      reason: string
    }>
  }
}

interface RepairNovelExecutionOptions {
  workId: number
  chapterId: number
  content: string
  blockers: string[]
  maxRounds: number
  onRoundStart?: (round: number) => void
  onCandidate?: (content: string) => Promise<void> | void
  onGateChecked?: (gate: NovelExecutionGateResult) => void
}

export interface RepairNovelExecutionResult {
  content: string
  gate: NovelExecutionGateResult
  rounds: number
}

/** 使用执行门禁的最新阻塞项定向修复正文，并在每轮后重新执行同一门禁。 */
export async function repairNovelExecutionUntilChecked(
  options: RepairNovelExecutionOptions
): Promise<RepairNovelExecutionResult> {
  let content = options.content
  let blockers = [...options.blockers]
  let gate: NovelExecutionGateResult = {
    passed: false,
    blockers,
    warnings: []
  }

  for (let round = 1; round <= options.maxRounds; round++) {
    options.onRoundStart?.(round)
    const repaired = await window.anovel.invoke(
      'novel:repairExecutionCandidate',
      options.workId,
      options.chapterId,
      content,
      blockers
    ) as { success: boolean; content?: string; error?: string }
    if (!repaired.success || !repaired.content?.trim()) {
      throw new Error(repaired.error || '章节执行定向修复失败')
    }

    content = repaired.content.trim()
    await options.onCandidate?.(content)
    gate = await window.anovel.invoke(
      'consistency:gate',
      options.workId,
      options.chapterId,
      content
    ) as NovelExecutionGateResult
    options.onGateChecked?.(gate)
    if (gate.passed || !gate.execution) {
      return { content, gate, rounds: round }
    }
    blockers = [...gate.blockers]
  }

  return { content, gate, rounds: options.maxRounds }
}
