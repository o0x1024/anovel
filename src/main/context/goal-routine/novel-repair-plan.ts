import { volumeChapterDAO } from '../../db'
import { loadWritingPlan } from '../writing-plan'
import { bodyWordCountBounds, countWords } from '../../../shared/body-word-target'
import type { GoalCheckResult, StoryGoalConfig } from './story-goal-checker'
import { MAX_AUTO_NOVEL_REPAIR_CHAPTERS } from './novel-goal-policy'
import type { ChapterWordRangeFailure } from './novel-chapter-acceptance'

export interface RepairPlan {
  action: 'draft_missing' | 'normalize_length' | 'expand' | 'compress' | 'execution_contract' | 'deai' | 'quality' | 'emotion' | 'goal_align' | 'systemic' | 'cluster' | 'volume'
  scope: 'sentence' | 'chapter' | 'cluster' | 'volume'
  targetChapterIds: number[]
  hint: string
  issueCodes?: string[]
  evidenceFingerprint?: string
  wordRange?: ChapterWordRangeFailure
}

export function buildNovelRepairPlan(workId: number, check: GoalCheckResult, config: StoryGoalConfig): RepairPlan {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const emptyChapters = chapters.filter(c => !c.content?.trim())
  if (emptyChapters.length > 0) {
    return { action: 'draft_missing', scope: 'chapter', targetChapterIds: emptyChapters.map(c => c.id), hint: '先生成缺失章节正文' }
  }

  const systemicBlockers = (check.systemicIssues ?? []).filter(issue => issue.severity === 'blocker')
  if (systemicBlockers.length > 0) {
    const priority = [...systemicBlockers].sort((a, b) => {
      const weight = { volume: 4, cluster: 3, chapter: 2, sentence: 1 }
      return weight[b.scope] - weight[a.scope]
    })[0]
    const ids = [...new Set(systemicBlockers
      .filter(issue => issue.scope === priority.scope)
      .flatMap(issue => issue.chapterIds))]
    const scope = priority.scope === 'sentence' ? 'sentence' : priority.scope
    return {
      action: scope === 'volume' ? 'volume' : scope === 'cluster' ? 'cluster' : 'systemic',
      scope,
      targetChapterIds: ids.slice(0, MAX_AUTO_NOVEL_REPAIR_CHAPTERS),
      hint: systemicBlockers.map(issue => `${issue.code}：${issue.message}；${issue.recommendedAction}`).join('\n'),
      issueCodes: [...new Set(systemicBlockers.map(issue => issue.code))],
      evidenceFingerprint: systemicBlockers.map(issue => `${issue.code}:${issue.chapterIds.join(',')}:${issue.evidence.join('|')}`).sort().join('\n')
    }
  }

  const gateFailures = check.chapterDiagnostics.filter(d => d.gateBlockers > 0 || d.antiAiViolations > 0)
  if (gateFailures.length > 0) {
    return { action: 'deai', scope: 'sentence', targetChapterIds: gateFailures.slice(0, 6).map(d => d.chapterId), hint: '修复一致性门禁与去AI问题' }
  }

  const perChapterTarget = loadWritingPlan(workId).wordsPerChapter || 4000
  const bounds = bodyWordCountBounds(perChapterTarget)
  const shortChapters = chapters.filter(chapter => countWords(chapter.content ?? '') < bounds.min)
  if (shortChapters.length > 0) {
    const target = shortChapters[0]
    const actual = countWords(target?.content ?? '')
    return {
      action: 'normalize_length',
      scope: 'chapter',
      targetChapterIds: [target.id],
      hint: `扩写至每章 ${bounds.min}-${bounds.max} 字，增加有效冲突和因果细节，禁止注水`,
      wordRange: { actual, min: bounds.min, target: perChapterTarget, max: bounds.max, direction: 'expand' }
    }
  }

  const longChapters = chapters.filter(chapter => countWords(chapter.content ?? '') > bounds.max)
  if (longChapters.length > 0) {
    const target = longChapters[0]
    const actual = countWords(target?.content ?? '')
    return {
      action: 'normalize_length',
      scope: 'chapter',
      targetChapterIds: [target.id],
      hint: `压缩至每章 ${bounds.min}-${bounds.max} 字，只删除重复解释和无推进段落`,
      wordRange: { actual, min: bounds.min, target: perChapterTarget, max: bounds.max, direction: 'compress' }
    }
  }

  const systemicWarnings = (check.systemicIssues ?? []).filter(issue => issue.severity === 'warning')
  if (systemicWarnings.length > 0) {
    const sentenceWarnings = systemicWarnings.filter(issue => issue.scope === 'sentence')
    const selected = sentenceWarnings.length > 0 ? sentenceWarnings : systemicWarnings
    return {
      action: sentenceWarnings.length > 0 ? 'deai' : 'cluster',
      scope: sentenceWarnings.length > 0 ? 'sentence' : 'cluster',
      targetChapterIds: [...new Set(selected.flatMap(issue => issue.chapterIds))].slice(0, 8),
      hint: selected.map(issue => `${issue.code}：${issue.message}；证据：${issue.evidence.join('；')}`).join('\n'),
      issueCodes: selected.map(issue => issue.code),
      evidenceFingerprint: selected.map(issue => `${issue.code}:${issue.chapterIds.join(',')}`).join('|')
    }
  }

  const weakIds = check.weakChapterTitles
    .map(title => chapters.find(chapter => chapter.title === title
      || chapter.title.includes(title)
      || title.includes(chapter.title))?.id)
    .filter((id): id is number => id != null)
  const targetChapterIds = weakIds.length > 0
    ? weakIds.slice(0, 3)
    : chapters
      .filter((_, index) => index === 0 || index === Math.floor(chapters.length / 2) || index === chapters.length - 1)
      .map(chapter => chapter.id)
  return {
    action: 'goal_align',
    scope: 'chapter',
    targetChapterIds,
    hint: `修复整书目标与结构问题：${check.storyIssues.slice(0, 3).join('；') || check.goalMatchReason || check.overallStoryReason}`
  }
}
