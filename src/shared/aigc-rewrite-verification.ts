import type { AigcDetectResult, AigcDistribution } from './aigc-detect-types'

/** 自动应用的本地风险门禁。它是编辑工作流阈值，不是作者身份判定。 */
export const AIGC_REWRITE_MAX_SUSPECTED_PERCENT = 15
export const AIGC_REWRITE_MAX_AI_PERCENT = 0
export const AIGC_REWRITE_MAX_DISAGREEMENT_PERCENT = 40

export interface AigcRewriteVerificationGate {
  passed: boolean
  reasons: string[]
  distribution: AigcDistribution
}

export function evaluateAigcRewriteVerification(
  result: Pick<AigcDetectResult, 'segments' | 'distribution' | 'diagnostics'>
): AigcRewriteVerificationGate {
  const reasons: string[] = []
  const { distribution } = result
  if (distribution.ai > AIGC_REWRITE_MAX_AI_PERCENT || result.segments.some(segment => segment.category === 'ai')) {
    reasons.push(`仍有AI特征覆盖${distribution.ai}%`)
  }
  if (distribution.suspected_ai > AIGC_REWRITE_MAX_SUSPECTED_PERCENT) {
    reasons.push(`疑似AI覆盖${distribution.suspected_ai}%超过${AIGC_REWRITE_MAX_SUSPECTED_PERCENT}%门槛`)
  }
  const disagreement = result.diagnostics?.detectorDisagreementShare
  if (typeof disagreement !== 'number') {
    reasons.push('缺少双检测器分歧诊断，不能自动应用')
  } else if (disagreement > AIGC_REWRITE_MAX_DISAGREEMENT_PERCENT) {
    reasons.push(`双检测器分歧覆盖${disagreement}%过高，需人工复核`)
  }
  return { passed: reasons.length === 0, reasons, distribution }
}

export function markAiAssistedRewrite(
  result: AigcDetectResult,
  method: 'full_document' | 'sentence'
): AigcDetectResult {
  return {
    ...result,
    authorship: {
      mode: 'ai_assisted',
      method,
      note: '文本经过AI辅助改写；检测百分比只表示当前本地特征覆盖，不代表人工作者身份。'
    }
  }
}

export interface BoundedRewriteAttempt<T> {
  accepted: boolean
  value: T
}

/** 两种改写入口共用的有界尝试器，保证成功即停、失败不超过上限。 */
export async function runBoundedRewriteAttempts<T>(
  maxAttempts: number,
  attempt: (attemptNumber: number) => Promise<BoundedRewriteAttempt<T>>
): Promise<{ accepted: boolean; attempts: number; value: T }> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('改写尝试次数必须是正整数')
  }
  let last: BoundedRewriteAttempt<T> | null = null
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    last = await attempt(attemptNumber)
    if (last.accepted) return { accepted: true, attempts: attemptNumber, value: last.value }
  }
  if (!last) throw new Error('改写尝试没有返回结果')
  return { accepted: false, attempts: maxAttempts, value: last.value }
}
