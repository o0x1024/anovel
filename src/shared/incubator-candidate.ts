/** 候选标题规范化（与入库去重逻辑一致） */
export function normalizeCandidateTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ')
}
