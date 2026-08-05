import { storyStateDAO, volumeChapterDAO } from '../../db'
import type { ChapterPatternFingerprintRow, StoryStateFactRow } from '../../db'
import type { ChapterRow } from '../../db/dao/chapter-dao'
import { reconcileChapterPatternWithOutlineDiagnosis } from '../memory-extract'
import {
  issueEvidenceFingerprint,
  type NovelSystemicAssessment,
  type NovelSystemIssue
} from '../../../shared/novel-systemic-types'

type WorkChapter = ChapterRow & { volume_name?: string }

const EMPTY_DELTA = /^(?:|无|没有|未变化|无变化|保持|无推进|未推进|不变|none|unchanged)$/i
const FAILURE_OUTCOME = /失败|受挫|撤退|逃|败|损失|被俘|被杀|未达成|fail|retreat|loss/i

function valueText(row: StoryStateFactRow): string {
  try { return JSON.stringify(JSON.parse(row.value_json)) } catch { return row.value_json }
}

function isAllowedIrreversibleProgression(prior: StoryStateFactRow, current: StoryStateFactRow): boolean {
  if (prior.value_type === 'number' && current.value_type === 'number') {
    try {
      const before = Number(JSON.parse(prior.value_json))
      const after = Number(JSON.parse(current.value_json))
      return Number.isFinite(before) && Number.isFinite(after) && after >= before
    } catch { return false }
  }
  if (prior.value_type === 'set' && current.value_type === 'set') {
    try {
      const before = JSON.parse(prior.value_json) as unknown
      const after = JSON.parse(current.value_json) as unknown
      if (!Array.isArray(before) || !Array.isArray(after)) return false
      const afterSet = new Set(after.map(String))
      return before.every(value => afterSet.has(String(value)))
    } catch { return false }
  }
  return false
}

function issue(value: NovelSystemIssue): NovelSystemIssue {
  return { ...value, chapterIds: [...new Set(value.chapterIds)] }
}

export function detectStoryStateIssues(facts: StoryStateFactRow[]): NovelSystemIssue[] {
  const issues: NovelSystemIssue[] = []
  const latest = new Map<string, StoryStateFactRow>()
  const unlocked = new Map<string, Set<string>>()
  const completed = new Set<string>()
  const withinChapter = new Map<string, StoryStateFactRow>()

  for (const fact of facts) {
    const key = `${fact.entity.trim()}::${fact.state_key.trim()}`
    const chapterKey = `${fact.chapter_id}::${key}`
    const currentValue = valueText(fact)
    const sameChapter = withinChapter.get(chapterKey)
    if (sameChapter && valueText(sameChapter) !== currentValue) {
      issues.push(issue({
        code: 'STATE_CONTRADICTION', scope: 'chapter', severity: 'blocker',
        chapterIds: [fact.chapter_id],
        evidence: [sameChapter.evidence ?? valueText(sameChapter), fact.evidence ?? currentValue],
        message: `${fact.entity}的${fact.state_key}在同一章出现互相冲突的状态`,
        recommendedAction: '以章节事实和既有状态为准重写冲突段落，并重新抽取状态'
      }))
    }
    withinChapter.set(chapterKey, fact)

    const prior = latest.get(key)
    if (prior?.irreversible && valueText(prior) !== currentValue && fact.transition !== 'invalidate'
      && !isAllowedIrreversibleProgression(prior, fact)) {
      issues.push(issue({
        code: 'STATE_REGRESSION', scope: 'cluster', severity: 'blocker',
        chapterIds: [prior.chapter_id, fact.chapter_id],
        evidence: [prior.evidence ?? valueText(prior), fact.evidence ?? currentValue],
        message: `${fact.entity}的不可逆状态“${fact.state_key}”发生无解释回退`,
        recommendedAction: '从首次状态分歧处重写受影响章节簇，禁止覆盖不可逆事实'
      }))
    }

    if (fact.transition === 'complete') {
      if (completed.has(key)) {
        issues.push(issue({
          code: 'TASK_COMPLETED_TWICE', scope: 'cluster', severity: 'blocker',
          chapterIds: [prior?.chapter_id ?? fact.chapter_id, fact.chapter_id],
          evidence: [prior?.evidence ?? '', fact.evidence ?? ''].filter(Boolean),
          message: `${fact.entity}的${fact.state_key}被重复完成`,
          recommendedAction: '保留首次完成事件，将后续事件改为新任务或删除重复兑现'
        }))
      }
      completed.add(key)
    }

    if (fact.transition === 'unlock') {
      const set = unlocked.get(key) ?? new Set<string>()
      let values: unknown[] = []
      try {
        const parsed = JSON.parse(fact.value_json) as unknown
        values = Array.isArray(parsed) ? parsed : [parsed]
      } catch { values = [fact.value_json] }
      const duplicate = values.map(String).filter(value => set.has(value))
      if (duplicate.length > 0) {
        issues.push(issue({
          code: 'STATE_DUPLICATE_UNLOCK', scope: 'cluster', severity: 'blocker',
          chapterIds: [prior?.chapter_id ?? fact.chapter_id, fact.chapter_id],
          evidence: duplicate,
          message: `${fact.entity}重复解锁${duplicate.join('、')}`,
          recommendedAction: '删除重复解锁，或明确这是不同层级且具备新的能力边界'
        }))
      }
      for (const value of values) set.add(String(value))
      unlocked.set(key, set)
    }
    latest.set(key, fact)
  }
  return issues
}

function addRepeatedWindowIssue(
  issues: NovelSystemIssue[],
  rows: ChapterPatternFingerprintRow[],
  selector: (row: ChapterPatternFingerprintRow) => string,
  code: 'REPEATED_SOLUTION' | 'REPEATED_HOOK',
  label: string
): void {
  const counts = new Map<string, ChapterPatternFingerprintRow[]>()
  for (const row of rows) {
    const value = selector(row).trim().toLowerCase()
    if (!value || EMPTY_DELTA.test(value)) continue
    const group = counts.get(value) ?? []
    group.push(row)
    counts.set(value, group)
  }
  for (const [value, group] of counts) {
    if (group.length < 3) continue
    issues.push(issue({
      code, scope: 'cluster', severity: 'blocker', chapterIds: group.map(row => row.chapter_id),
      evidence: [`${label}“${value}”在${rows.length}章窗口出现${group.length}次`],
      message: `连续章节重复使用相同${label}`,
      recommendedAction: `重构该章节簇，使${label}至少在目标、阻力、执行方式或结果上产生实质变化`
    }))
  }
}

function repeatedProseIssues(chapters: WorkChapter[]): NovelSystemIssue[] {
  if (chapters.length < 4) return []
  const grams = new Map<string, Set<number>>()
  for (const chapter of chapters) {
    const text = (chapter.content ?? '').replace(/[\s\p{P}\p{S}\d]/gu, '')
    const seen = new Set<string>()
    for (let i = 0; i <= text.length - 8; i += 2) {
      const gram = text.slice(i, i + 8)
      if (!/[\p{Script=Han}]{6}/u.test(gram) || /^(.)\1+$/.test(gram)) continue
      seen.add(gram)
    }
    for (const gram of seen) {
      const ids = grams.get(gram) ?? new Set<number>()
      ids.add(chapter.id)
      grams.set(gram, ids)
    }
  }
  const threshold = chapters.length <= 10
    ? Math.max(3, Math.ceil(chapters.length * 0.6))
    : Math.max(5, Math.ceil(chapters.length * 0.3))
  const repeated = [...grams.entries()]
    .filter(([, ids]) => ids.size >= threshold)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 5)
  // 单个固定专名或世界观术语不足以证明模板复用；至少三个相邻八字片段
  // 跨越同一批章节，才视为正文生产模式没有变化。
  if (repeated.length < 3) return []
  return [issue({
    code: 'PROSE_TEMPLATE_REPETITION', scope: 'sentence', severity: 'blocker',
    chapterIds: [...new Set(repeated.flatMap(([, ids]) => [...ids]))],
    evidence: repeated.map(([gram, ids]) => `“${gram}”跨${ids.size}章重复`),
    message: '正文存在跨章节高频模板短语',
    recommendedAction: '从首次重复处重构解决机制和行动链；不能只替换措辞，且必须保留已提交事实和人物状态'
  })]
}

function reconcileCompletedFingerprint(
  row: ChapterPatternFingerprintRow,
  chapter: WorkChapter | undefined
): ChapterPatternFingerprintRow {
  if (chapter?.status !== 'completed') return row
  const reconciled = reconcileChapterPatternWithOutlineDiagnosis({
    conflictType: row.conflict_type,
    protagonistMethod: row.protagonist_method,
    antagonistTactic: row.antagonist_tactic,
    antagonistOutcome: row.antagonist_outcome,
    opponentAdjustment: row.opponent_adjustment,
    locationType: row.location_type,
    hookType: row.hook_type,
    costType: row.cost_type,
    relationshipDelta: row.relationship_delta,
    volumeObjectiveDelta: row.volume_objective_delta,
    payoffType: row.payoff_type
  }, chapter.outline_diagnosis)
  return {
    ...row,
    opponent_adjustment: reconciled.opponentAdjustment,
    relationship_delta: reconciled.relationshipDelta,
    volume_objective_delta: reconciled.volumeObjectiveDelta,
    payoff_type: reconciled.payoffType
  }
}

export function detectChapterPatternIssues(
  chapters: WorkChapter[],
  fingerprints: ChapterPatternFingerprintRow[],
  options: { requireFingerprints?: boolean; includeProseScan?: boolean } = {}
): NovelSystemIssue[] {
  const issues: NovelSystemIssue[] = []
  const chapterById = new Map(chapters.map(chapter => [chapter.id, chapter]))
  const fingerprintByChapter = new Map(fingerprints.map(row => [
    row.chapter_id,
    reconcileCompletedFingerprint(row, chapterById.get(row.chapter_id))
  ]))
  if (options.requireFingerprints) {
    const missing = chapters.filter(chapter => chapter.content?.trim() && !fingerprintByChapter.has(chapter.id))
    if (missing.length > 0) {
      issues.push(issue({
        code: 'MISSING_PATTERN_FINGERPRINT', scope: 'chapter', severity: 'blocker',
        chapterIds: missing.map(chapter => chapter.id),
        evidence: missing.map(chapter => chapter.title).slice(0, 8),
        message: `${missing.length}章缺少模式指纹，无法执行跨章门禁`,
        recommendedAction: '重新抽取这些章节的叙事记忆与模式指纹'
      }))
    }
  }

  const volumeGroups = new Map<number, WorkChapter[]>()
  for (const chapter of chapters) {
    const group = volumeGroups.get(chapter.volume_id) ?? []
    group.push(chapter)
    volumeGroups.set(chapter.volume_id, group)
  }
  for (const volumeChapters of volumeGroups.values()) {
    const rows = volumeChapters.map(chapter => fingerprintByChapter.get(chapter.id)).filter(Boolean) as ChapterPatternFingerprintRow[]
    for (let start = 0; start < rows.length; start++) {
      const window = rows.slice(start, start + 5)
      if (window.length < 4) continue
      addRepeatedWindowIssue(issues, window, row => `${row.conflict_type}::${row.protagonist_method}`, 'REPEATED_SOLUTION', '冲突解法')
      addRepeatedWindowIssue(issues, window, row => row.hook_type, 'REPEATED_HOOK', '章末钩子')

      if (window.length >= 4 && window.slice(0, 4).every(row => row.payoff_type === 'debt')) {
        issues.push(issue({
          code: 'PAYOFF_DEBT_STREAK', scope: 'cluster', severity: 'blocker',
          chapterIds: window.slice(0, 4).map(row => row.chapter_id),
          evidence: ['连续4章只有欠账，没有阶段兑现'],
          message: '连续蓄力导致读者承诺长期不兑现',
          recommendedAction: '将其中至少一章重构为partial或major兑现，并改变人物状态'
        }))
      }
      if (window.slice(0, 3).every(row => EMPTY_DELTA.test(row.volume_objective_delta.trim()))) {
        issues.push(issue({
          code: 'VOLUME_OBJECTIVE_STAGNATION', scope: 'cluster', severity: 'blocker',
          chapterIds: window.slice(0, 3).map(row => row.chapter_id),
          evidence: ['连续3章未改变分卷核心目标进度'],
          message: '分卷主线在连续章节中停滞',
          recommendedAction: '合并无推进章节，或为每章增加可验证的目标状态变化'
        }))
      }
      if (window.every(row => EMPTY_DELTA.test(row.relationship_delta.trim()))) {
        issues.push(issue({
          code: 'RELATIONSHIP_STAGNATION', scope: 'cluster', severity: 'warning',
          chapterIds: window.map(row => row.chapter_id),
          evidence: ['连续5章人物关系没有变化'],
          message: '主要人物关系线长期停滞',
          recommendedAction: '通过选择、误解、信任、背叛或共同代价改变至少一组核心关系'
        }))
      }
      const failedOpponentRows = window.filter(row => FAILURE_OUTCOME.test(row.antagonist_outcome))
      if (failedOpponentRows.length >= 3 && failedOpponentRows.every(row => EMPTY_DELTA.test(row.opponent_adjustment.trim()))) {
        issues.push(issue({
          code: 'ANTAGONIST_NO_LEARNING', scope: 'cluster', severity: 'blocker',
          chapterIds: failedOpponentRows.map(row => row.chapter_id),
          evidence: failedOpponentRows.map(row => `${row.antagonist_tactic}→${row.antagonist_outcome}`),
          message: '对手连续失败却没有学习或调整策略',
          recommendedAction: '让对手基于已知情报改变工具、目标、时机、联盟或欺骗方式'
        }))
      }
    }
    if (options.includeProseScan) issues.push(...repeatedProseIssues(volumeChapters))
  }

  const unique = new Map<string, NovelSystemIssue>()
  for (const item of issues) {
    const key = `${item.code}:${item.chapterIds.join(',')}:${item.evidence[0] ?? ''}`
    if (!unique.has(key)) unique.set(key, item)
  }
  return [...unique.values()]
}

export function assessNovelSystemics(
  workId: number,
  options: { requireFingerprints?: boolean; includeProseScan?: boolean } = {}
): NovelSystemicAssessment {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const issues = [
    ...detectStoryStateIssues(storyStateDAO.listFactsByWork(workId)),
    ...detectChapterPatternIssues(chapters, storyStateDAO.listFingerprintsByWork(workId), options)
  ]
  return {
    issues,
    issueFingerprint: issueEvidenceFingerprint(issues),
    blockerCount: issues.filter(item => item.severity === 'blocker').length,
    warningCount: issues.filter(item => item.severity === 'warning').length
  }
}
