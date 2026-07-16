import type { StoryForensicIssue } from './story-whole-evaluator'

export type StoryForensicRepairMode = 'dynamic' | 'retry_audit' | 'reset_beats' | 'reset_engine'

export interface StoryForensicRepairRoute {
  mode: StoryForensicRepairMode
  action: 'paragraph' | 'scene' | 'beat' | 'storyline'
  targetChapterIds: number[]
  hint: string
  fingerprint: string
}

export function storyForensicFingerprint(issues: StoryForensicIssue[]): string {
  return issues.map(issue => [
    issue.code,
    issue.scope,
    [...issue.repairChapterTitles].sort().join(','),
    // 结构化审计以固定问题码+位置判定同一证据，避免模型改写证据措辞后计数归零。
    issue.code === 'LEGACY_FORENSIC_BLOCKER'
      ? issue.evidence[0]?.replace(/\d+/g, '#').replace(/\s+/g, '').slice(0, 120) ?? ''
      : ''
  ].join(':')).sort().join('|').slice(0, 6000)
}

function resolveIds(
  chapters: Array<{ id: number; title: string }>,
  titles: string[]
): number[] {
  return [...new Set(titles.flatMap(title => chapters
    .filter(chapter => chapter.title === title || chapter.title.includes(title) || title.includes(chapter.title))
    .map(chapter => chapter.id)))]
}

function expandNeighbors(chapters: Array<{ id: number; title: string }>, ids: number[]): number[] {
  const indexes = ids.map(id => chapters.findIndex(chapter => chapter.id === id)).filter(index => index >= 0)
  const expanded = new Set<number>(ids)
  for (const index of indexes) {
    if (chapters[index - 1]) expanded.add(chapters[index - 1].id)
    if (chapters[index + 1]) expanded.add(chapters[index + 1].id)
  }
  return chapters.filter(chapter => expanded.has(chapter.id)).map(chapter => chapter.id)
}

export function routeStoryForensicRepair(
  chapters: Array<{ id: number; title: string }>,
  issues: StoryForensicIssue[],
  sameEvidenceCount: number
): StoryForensicRepairRoute {
  const fingerprint = storyForensicFingerprint(issues)
  const actionableIssues = issues.filter(issue => issue.code !== 'FORENSIC_EVALUATOR_ERROR')
  const feedback = issues.map(issue => [
    `${issue.code}（${issue.scope}）：${issue.message}`,
    issue.evidence.length > 0 ? `证据：${issue.evidence.join('；')}` : '',
    `修复：${issue.recommendedAction}`
  ].filter(Boolean).join('；')).join('\n')

  if (actionableIssues.length === 0 && issues.some(issue => issue.code === 'FORENSIC_EVALUATOR_ERROR')) {
    return {
      mode: 'retry_audit', action: 'scene', targetChapterIds: [], fingerprint,
      hint: `法医评估器返回无效，只重试审计，不修改或删除正文。\n${feedback}`
    }
  }

  const global = actionableIssues.some(issue => issue.scope === 'story_engine' || !issue.repairable)
  if (global) {
    return {
      mode: sameEvidenceCount >= 2 ? 'reset_engine' : 'retry_audit',
      action: 'storyline', targetChapterIds: [], fingerprint,
      hint: `${sameEvidenceCount >= 2 ? '两次独立审计均确认故事发动机层硬伤' : '首次检出全局硬伤，先独立复核'}。\n${feedback}`
    }
  }

  if (sameEvidenceCount >= 3) {
    return {
      mode: sameEvidenceCount >= 4 ? 'reset_engine' : 'reset_beats',
      action: sameEvidenceCount >= 4 ? 'storyline' : 'beat',
      targetChapterIds: [], fingerprint,
      hint: `${sameEvidenceCount >= 4
        ? '同一证据在整组节拍重建后仍存在，才升级为故事发动机重建。'
        : '同一证据已经过两轮动态修复仍未消失，才升级为整组节拍重建。'}\n${feedback}`
    }
  }

  let targetIds = resolveIds(chapters, actionableIssues.flatMap(issue =>
    issue.repairChapterTitles.length > 0 ? issue.repairChapterTitles : issue.chapterTitles
  ))
  if (targetIds.length === 0 && chapters.length > 0) targetIds = [chapters.at(-1)!.id]
  if (sameEvidenceCount === 2) targetIds = expandNeighbors(chapters, targetIds)

  const scopes = new Set(actionableIssues.map(issue => issue.scope))
  const action: StoryForensicRepairRoute['action'] = sameEvidenceCount === 2 || scopes.has('beat_cluster')
    ? 'beat'
    : scopes.has('scene') ? 'scene' : 'paragraph'
  return {
    mode: 'dynamic', action, targetChapterIds: targetIds, fingerprint,
    hint: [
      `法医硬伤第 ${sameEvidenceCount} 轮动态修复。只修改指定节拍，保留其他已通过内容。`,
      sameEvidenceCount === 2 ? '上轮最小修复未消除证据，本轮扩大到相邻铺垫—兑现节拍簇。' : '',
      feedback,
      '修复后必须保持时间、证据来源、人物知情和处置程序可从前文推导；不得用新巧合覆盖旧硬伤。'
    ].filter(Boolean).join('\n')
  }
}
