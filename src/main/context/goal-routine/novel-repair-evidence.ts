import type { GoalCheckResult } from './story-goal-checker'

export function repairReasonSignature(reasons: string[]): string {
  return reasons
    .map(reason => reason.replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim())
    .sort()
    .join('|')
    .slice(0, 1000)
}

export function repairEvidenceSnapshot(check: GoalCheckResult): { fingerprint: string; count: number } {
  if ((check.systemicIssues ?? []).length > 0) {
    return {
      fingerprint: check.systemicIssues
        .map(issue => `${issue.code}:${issue.chapterIds.join(',')}:${issue.evidence.join('|')}`)
        .sort()
        .join('\n')
        .slice(0, 12000),
      count: check.systemicIssues.length
    }
  }
  const failingChapters = check.chapterDiagnostics
    .filter(item => item.qualityHardFail || item.gateBlockers > 0 || item.antiAiViolations > 0 || item.emotionPassed === false)
    .map(item => `${item.chapterId}:${item.qualityScore}:${item.gateBlockers}:${item.antiAiViolations}:${item.emotionScore}`)
  return {
    fingerprint: [check.reasons.join('\n'), ...failingChapters].join('\n').slice(0, 12000),
    count: failingChapters.length || check.reasons.length
  }
}
