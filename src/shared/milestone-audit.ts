/** 里程碑审计维度 */
export type AuditDimension =
  | '主线偏离'
  | '角色崩塌'
  | '节奏塌方'
  | '伏笔黑洞'
  | '逻辑矛盾'
  | '重复模式'
  | '终局对齐'

export type AuditSeverity = 'blocking' | 'warning' | 'info'

export interface AuditIssue {
  dimension: AuditDimension
  severity: AuditSeverity
  evidence: string
  suggestion: string
}

export type AuditVerdict = 'pass' | 'warning' | 'blocking'

export interface MilestoneAuditResult {
  verdict: AuditVerdict
  driftScore: number        // 0-100, 越高越偏
  issues: AuditIssue[]
  summary: string           // 一句话总结
  strengths: string[]       // 做得好的地方
}

/** 被动监控指标 */
export interface PassiveMonitorResult {
  foreshadowingRecoveryRate: number
  deepForeshadowingPending: number
  charactersLongAbsent: { name: string; chaptersAgo: number }[]
  newCharacterRate: number       // 每章平均新增角色数
  emotionFlatStreak: number      // 连续低压章节数
  repeatedPatternWarnings: string[]
  timelineGaps: string[]
}
