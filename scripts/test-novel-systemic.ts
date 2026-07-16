import assert from 'node:assert/strict'
import { detectChapterPatternIssues, detectStoryStateIssues } from '../src/main/context/goal-routine/novel-systemic-gate'
import type { ChapterPatternFingerprintRow, StoryStateFactRow } from '../src/main/db'

function fact(input: Partial<StoryStateFactRow> & Pick<StoryStateFactRow, 'chapter_id' | 'entity' | 'state_key' | 'value_json' | 'transition'>): StoryStateFactRow {
  return {
    id: input.chapter_id,
    work_id: 1,
    value_type: 'enum',
    irreversible: 0,
    evidence: null,
    create_time: '',
    ...input
  }
}

function fingerprint(chapterId: number, patch: Partial<ChapterPatternFingerprintRow> = {}): ChapterPatternFingerprintRow {
  return {
    chapter_id: chapterId,
    work_id: 1,
    conflict_type: `冲突${chapterId}`,
    protagonist_method: `解法${chapterId}`,
    antagonist_tactic: `策略${chapterId}`,
    antagonist_outcome: '暂时达成目标',
    opponent_adjustment: `调整${chapterId}`,
    location_type: `地点${chapterId}`,
    hook_type: `钩子${chapterId}`,
    cost_type: `代价${chapterId}`,
    relationship_delta: `关系变化${chapterId}`,
    volume_objective_delta: `目标推进${chapterId}`,
    payoff_type: 'partial',
    create_time: '',
    update_time: '',
    ...patch
  }
}

const duplicateCompletion = detectStoryStateIssues([
  fact({ chapter_id: 1, entity: '任务A', state_key: 'status', value_json: '"completed"', transition: 'complete' }),
  fact({ chapter_id: 3, entity: '任务A', state_key: 'status', value_json: '"completed"', transition: 'complete' })
])
assert(duplicateCompletion.some(issue => issue.code === 'TASK_COMPLETED_TWICE'))

const irreversibleRegression = detectStoryStateIssues([
  fact({ chapter_id: 2, entity: '角色A', state_key: '存活状态', value_json: '"死亡"', transition: 'update', irreversible: 1 }),
  fact({ chapter_id: 5, entity: '角色A', state_key: '存活状态', value_json: '"存活"', transition: 'update' })
])
assert(irreversibleRegression.some(issue => issue.code === 'STATE_REGRESSION'))

const duplicateUnlock = detectStoryStateIssues([
  fact({ chapter_id: 1, entity: '角色A', state_key: '权限', value_json: '["密钥"]', transition: 'unlock', value_type: 'set' }),
  fact({ chapter_id: 4, entity: '角色A', state_key: '权限', value_json: '["密钥","仪表盘"]', transition: 'unlock', value_type: 'set' })
])
assert(duplicateUnlock.some(issue => issue.code === 'STATE_DUPLICATE_UNLOCK'))

const monotonicIrreversibleProgress = detectStoryStateIssues([
  fact({ chapter_id: 1, entity: '项目A', state_key: '已完成节点', value_json: '2', transition: 'increase', value_type: 'number', irreversible: 1 }),
  fact({ chapter_id: 2, entity: '项目A', state_key: '已完成节点', value_json: '3', transition: 'increase', value_type: 'number', irreversible: 1 })
])
assert(!monotonicIrreversibleProgress.some(issue => issue.code === 'STATE_REGRESSION'))

const irreversibleSetExpansion = detectStoryStateIssues([
  fact({ chapter_id: 1, entity: '角色A', state_key: '已掌握线索', value_json: '["甲"]', transition: 'update', value_type: 'set', irreversible: 1 }),
  fact({ chapter_id: 2, entity: '角色A', state_key: '已掌握线索', value_json: '["甲","乙"]', transition: 'update', value_type: 'set', irreversible: 1 })
])
assert(!irreversibleSetExpansion.some(issue => issue.code === 'STATE_REGRESSION'))

const chapters = Array.from({ length: 5 }, (_, index) => ({
  id: index + 1,
  volume_id: 1,
  title: `第${index + 1}章`,
  content: `第${index + 1}章正文`,
  word_count: 1000,
  sort: index + 1,
  status: 'completed'
}))
const repeated = chapters.map((_, index) => fingerprint(index + 1, {
  conflict_type: index < 3 ? '追捕' : `冲突${index}`,
  protagonist_method: index < 3 ? '正面击退' : `解法${index}`,
  hook_type: index < 3 ? '敌人逼近' : `钩子${index}`,
  antagonist_outcome: index < 3 ? '失败撤退' : '达成目标',
  opponent_adjustment: index < 3 ? '无变化' : `调整${index}`,
  payoff_type: index < 4 ? 'debt' : 'partial'
}))
const patternIssues = detectChapterPatternIssues(chapters as never[], repeated, { requireFingerprints: true })
assert(patternIssues.some(issue => issue.code === 'REPEATED_SOLUTION'))
assert(patternIssues.some(issue => issue.code === 'REPEATED_HOOK'))
assert(patternIssues.some(issue => issue.code === 'ANTAGONIST_NO_LEARNING'))
assert(patternIssues.some(issue => issue.code === 'PAYOFF_DEBT_STREAK'))

const missingPattern = detectChapterPatternIssues(chapters as never[], repeated.slice(0, 4), { requireFingerprints: true })
assert(missingPattern.some(issue => issue.code === 'MISSING_PATTERN_FINGERPRINT'))

const stagnant = chapters.map((_, index) => fingerprint(index + 1, {
  volume_objective_delta: index < 3 ? '无变化' : `目标推进${index}`
}))
const stagnantIssues = detectChapterPatternIssues(chapters as never[], stagnant)
assert(stagnantIssues.some(issue => issue.code === 'VOLUME_OBJECTIVE_STAGNATION'))

const varied = chapters.map((_, index) => fingerprint(index + 1))
const cleanIssues = detectChapterPatternIssues(chapters as never[], varied, { requireFingerprints: true })
assert.equal(cleanIssues.filter(issue => issue.severity === 'blocker').length, 0)

process.stdout.write('novel systemic gate tests passed\n')
