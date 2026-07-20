import assert from 'node:assert/strict'
import {
  buildStoryCandidateContextSource,
  canStartStoryFallbackEpoch,
  deriveRequiredStorySettingResolutions,
  detectStorySettingContradictions,
  detectStoryTextIntegrityIssues,
  derivedMemoryFailureDisposition,
  isStructuralStoryCandidateRejection,
  repairDeterministicStoryQuotes,
  resolveStoryModelCapability,
  shouldBlockStoryAntiAi,
  stableStoryHash,
  storyHarnessIssueKey,
  storyHarnessBudgetBlockers
} from '../src/shared/story-harness'
import { requireGoalTurnLimit } from '../src/shared/goal-turn-limit'

assert.equal(requireGoalTurnLimit(200), 200)
assert.throws(() => requireGoalTurnLimit(0), /大于等于 1 的整数/)
assert.throws(() => requireGoalTurnLimit(1.5), /大于等于 1 的整数/)
assert.throws(() => requireGoalTurnLimit('200'), /大于等于 1 的整数/)
assert.equal(canStartStoryFallbackEpoch(0), true)
assert.equal(canStartStoryFallbackEpoch(1), false)
const candidateContextA = buildStoryCandidateContextSource({ acceptedBody: '', outline: '旧节拍' })
const candidateContextB = buildStoryCandidateContextSource({ acceptedBody: '', outline: '新节拍' })
assert.notEqual(candidateContextA, candidateContextB)
assert.equal(
  candidateContextA,
  buildStoryCandidateContextSource({ acceptedBody: '', outline: '旧节拍' })
)
assert.equal(resolveStoryModelCapability().mode, 'conservative')
assert.equal(resolveStoryModelCapability().maxContinuityRepairs, 1)
assert.equal(resolveStoryModelCapability({ thinkingEnabled: true }).maxContinuityRepairs, 2)
assert.equal(derivedMemoryFailureDisposition('story', false), 'defer')
assert.equal(derivedMemoryFailureDisposition('novel', false), 'defer')
assert.equal(derivedMemoryFailureDisposition('story', true), 'cancel')
assert.equal(isStructuralStoryCandidateRejection('地点无过渡跳变，证据状态倒退'), true)
assert.equal(isStructuralStoryCandidateRejection('叙事记忆提取失败：证据不是正文原文片段'), false)
assert.equal(isStructuralStoryCandidateRejection('正文确定性门禁未通过：孤立引号行'), false)
assert.equal(repairDeterministicStoryQuotes('他说：\n“\n你来了。'), '他说：\n你来了。')
assert.equal(repairDeterministicStoryQuotes('“你来了。'), '“你来了。”')
assert.equal(repairDeterministicStoryQuotes('“你来了。\n她转身离开。'), '“你来了。”\n她转身离开。')
assert.equal(repairDeterministicStoryQuotes('”她转身离开。'), '她转身离开。')

assert.deepEqual(
  detectStoryTextIntegrityIssues('   ').map(issue => issue.code),
  ['EMPTY_BODY']
)
assert.ok(detectStoryTextIntegrityIssues('“你回来了。').some(issue => issue.code === 'UNBALANCED_QUOTES'))
assert.ok(detectStoryTextIntegrityIssues('他说：\n“').some(issue => issue.code === 'ISOLATED_QUOTE'))
assert.ok(detectStoryTextIntegrityIssues('我本来想说，但是').some(issue => issue.code === 'TRUNCATED_SENTENCE'))
assert.ok(detectStoryTextIntegrityIssues('老师讲了四挺钟的课，我记了四颇为钟的笔记。').some(issue => issue.code === 'CORRUPTED_SENTENCE'))
assert.ok(detectStoryTextIntegrityIssues('她以为我是真穷，只要当众揭穿').some(issue => issue.code === 'CORRUPTED_SENTENCE'))
assert.ok(detectStoryTextIntegrityIssues(
  '林晚走进教室。'.repeat(80),
  { povMode: 'first', povCharacter: '林晚' }
).some(issue => issue.code === 'POV_DRIFT'))
assert.ok(detectStoryTextIntegrityIssues(
  '旧事终于结束。'.repeat(30) + '下一个任务已经送到门口。',
  { finalBeat: true }
).some(issue => issue.code === 'FINAL_NEW_ARC'))

const conflictedEngine = [
  '主角靠低保维生，是某集团唯一继承人。',
  '她随手捐出一百万。',
  '爷爷是奥赛组委会主席，主角参加奥赛并以满分获得保送。',
  '公示期剩3天，另一处又写公示期还剩7天。'
].join('\n')
const codes = detectStorySettingContradictions(conflictedEngine).map(issue => issue.code)
assert.ok(codes.includes('POVERTY_WEALTH_CONFLICT'))
assert.ok(codes.includes('ADJUDICATOR_CONFLICT_OF_INTEREST'))
assert.ok(codes.includes('DEADLINE_CONTRADICTION'))
const harnessResolutions = deriveRequiredStorySettingResolutions(conflictedEngine)
assert.deepEqual(
  harnessResolutions.map(value => value.match(/^\[([^\]]+)\]/)?.[1]),
  ['POVERTY_WEALTH_CONFLICT', 'ADJUDICATOR_CONFLICT_OF_INTEREST', 'DEADLINE_CONTRADICTION']
)
assert.deepEqual(
  detectStorySettingContradictions(conflictedEngine, harnessResolutions.join('\n')),
  []
)
assert.ok(harnessResolutions[2].includes('剩余3天'))
assert.equal(detectStorySettingContradictions(
  '她早年靠低保维生，母亲去世后才被家族认回并继承财产，此后捐赠一百万元。'
).some(issue => issue.code === 'POVERTY_WEALTH_CONFLICT'), false)
assert.equal(detectStorySettingContradictions(
  conflictedEngine,
  '福利与财富冲突：福利退出早于财富取得。'
).some(issue => issue.code === 'POVERTY_WEALTH_CONFLICT'), false)
const explicitResolutions = [
  '母亲去世后先退出低保，随后才被家族认回并继承财产，两个时期不重叠。',
  '爷爷对主角相关奥赛命题、评审和成绩认定强制回避，成绩由无利益关系的省级奥赛委独立复核认定。',
  '统一公示期剩3天为准。'
].join('\n')
assert.deepEqual(
  detectStorySettingContradictions(conflictedEngine, explicitResolutions).map(issue => issue.code),
  []
)
assert.ok(detectStorySettingContradictions(
  conflictedEngine,
  '爷爷不参与评审。'
).some(issue => issue.code === 'ADJUDICATOR_CONFLICT_OF_INTEREST'))

assert.equal(shouldBlockStoryAntiAi(1, 3000), false)
assert.equal(shouldBlockStoryAntiAi(2, 1000), true)
assert.equal(shouldBlockStoryAntiAi(5, 10_000), true)
assert.deepEqual(storyHarnessBudgetBlockers(
  { issueAttempts: 2, candidatesForBeat: 4, wholeAudits: 2 },
  resolveStoryModelCapability()
), ['同一问题已达到修复上限', '当前节拍候选已达到上限', '整篇审计已达到上限'])
assert.equal(stableStoryHash('同一正文'), stableStoryHash('同一正文'))
assert.notEqual(stableStoryHash('正文甲'), stableStoryHash('正文乙'))
assert.equal(
  storyHarnessIssueKey({ code: 'TIMELINE_CONTRADICTION', severity: 'blocker', scope: 'engine', chapterIds: [2, 1], evidence: [], message: '时间冲突', expectedResult: '修复' }),
  storyHarnessIssueKey({ code: 'TIMELINE_CONTRADICTION', severity: 'blocker', scope: 'cluster', chapterIds: [1, 2], evidence: [], message: '同一时间冲突', expectedResult: '修复' })
)

console.log('story harness deterministic tests passed')
