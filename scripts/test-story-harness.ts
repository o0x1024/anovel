import assert from 'node:assert/strict'
import {
  buildStoryCandidateContextSource,
  deriveRequiredStorySettingResolutions,
  detectStorySettingContradictions,
  detectStoryTextIntegrityIssues,
  derivedMemoryFailureDisposition,
  isStructuralStoryCandidateRejection,
  repairDeterministicStoryCandidate,
  repairDeterministicStoryQuotes,
  repairDeterministicStorySentences,
  detectStoryDeadlineArithmeticIssues,
  resolveStoryModelCapability,
  shouldBlockStoryAntiAi,
  stableStoryHash,
  storyCandidateDefectSignature,
  storyHarnessIssueKey,
  storyHarnessBudgetBlockers
} from '../src/shared/story-harness'
import { requireGoalTurnLimit } from '../src/shared/goal-turn-limit'
import {
  validateStoryBoundaryContracts,
  validateStoryContinuityContracts
} from '../src/shared/story-hard-guards'
import {
  recognizeStoryQualityHardFail,
  type StoryQualityAiScoreBreakdown
} from '../src/shared/story-quality-score'

assert.equal(requireGoalTurnLimit(200), 200)
assert.throws(() => requireGoalTurnLimit(0), /大于等于 1 的整数/)
assert.throws(() => requireGoalTurnLimit(1.5), /大于等于 1 的整数/)
assert.throws(() => requireGoalTurnLimit('200'), /大于等于 1 的整数/)
const closedBoundary = [
  {
    continuity_contract: {
      entry_boundary: 'START',
      exit_boundary: '医院病房/林微微仍在楼上',
      time_anchor: '上午十点',
      start_location: '医院病房',
      end_location: '医院病房',
      entry_facts: ['主角在病房'],
      exit_facts: ['林微微仍在楼上']
    },
    tension_plan: { payoff_type: 'partial' }
  },
  {
    continuity_contract: {
      entry_boundary: '医院病房/林微微仍在楼上',
      exit_boundary: 'END',
      time_anchor: '十分钟后',
      elapsed_from_previous: '十分钟',
      start_location: '医院病房',
      end_location: '医院病房',
      entry_facts: ['林微微仍在楼上'],
      exit_facts: ['冲突结束']
    },
    tension_plan: { payoff_type: 'major' }
  }
]
assert.deepEqual(validateStoryBoundaryContracts(closedBoundary), [])
assert.equal(validateStoryContinuityContracts(closedBoundary).length, 0)
const brokenBoundary = [
  { continuity_contract: { entry_boundary: 'START', exit_boundary: '医院病房/林微微仍在楼上' } },
  { continuity_contract: { entry_boundary: '医院大厅/刚遇到林微微', exit_boundary: 'END' } }
]
assert.equal(validateStoryBoundaryContracts(brokenBoundary)[0]?.leftIndex, 0)
assert.match(validateStoryContinuityContracts(brokenBoundary)[0] ?? '', /不相等/)
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
const deterministicSentenceRepair = repairDeterministicStorySentences(
  '老师讲了四挺钟的课，我记了四颇为钟的笔记。其余事实不变。'
)
assert.equal(
  deterministicSentenceRepair.content,
  '老师讲了四十分钟的课，我记了四十分钟的笔记。其余事实不变。'
)
assert.deepEqual(deterministicSentenceRepair.repairs, [
  { before: '四挺钟', after: '四十分钟' },
  { before: '四颇为钟', after: '四十分钟' }
])
assert.equal(repairDeterministicStorySentences('会议持续四十分钟。').repairs.length, 0)
const liveCandidateRepair = repairDeterministicStoryCandidate(
  '第一段要一小时五颇为钟，第二段四颇为钟，第三段一小时二颇为钟，最后二颇为钟。“时间没错。'
)
assert.equal(
  liveCandidateRepair.content,
  '第一段要一小时五十分钟，第二段四十分钟，第三段一小时二十分钟，最后二十分钟。“时间没错。”'
)
assert.equal(liveCandidateRepair.repairCount, 5)
assert.deepEqual(liveCandidateRepair.sentenceRepairs.map(item => item.after), [
  '五十分钟',
  '四十分钟',
  '二十分钟',
  '二十分钟'
])
assert.equal(
  detectStoryDeadlineArithmeticIssues('现在是上午十点，十二个小时后就是下午四点。', 7)[0]?.code,
  'DEADLINE_ARITHMETIC_CONTRADICTION'
)
assert.deepEqual(detectStoryDeadlineArithmeticIssues('现在是上午十点，十二个小时后就是晚上十点。', 7), [])

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
  '张三走进教室。'.repeat(80),
  { povMode: 'first', povCharacter: '张三' }
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
const qualityBreakdown: StoryQualityAiScoreBreakdown = {
  scoreTotal: 55,
  hardFail: true,
  items: [],
  failedRules: ['通篇像流水账：缺少目标、阻力、选择和后果'],
  topIssues: [{ id: 'issue-1', evidence: '她只是按顺序完成了所有手续', fixHint: '加入选择与代价' }],
  anchorAlignment: []
}
assert.equal(
  recognizeStoryQualityHardFail(
    qualityBreakdown,
    '她只是按顺序完成了所有手续，然后回家。'
  ).recognized,
  true
)
assert.equal(
  recognizeStoryQualityHardFail(
    qualityBreakdown,
    '她当众拒绝签字，并承担失去工作的代价。'
  ).recognized,
  false,
  '无法在原文定位的 hard_fail 不得获得正文改写许可'
)
assert.equal(
  recognizeStoryQualityHardFail(
    { ...qualityBreakdown, failedRules: ['总体感觉不够精彩'] },
    '她只是按顺序完成了所有手续，然后回家。'
  ).recognized,
  false,
  '不受支持的主观规则不得升级为硬失败'
)
const defectIssues = detectStoryTextIntegrityIssues('老师讲了四颇为钟的课。')
assert.equal(
  storyCandidateDefectSignature(7, '老师讲了四颇为钟的课。', defectIssues),
  storyCandidateDefectSignature(7, '老师讲了四颇为钟的课。', defectIssues)
)
assert.notEqual(
  storyCandidateDefectSignature(7, '老师讲了四颇为钟的课。', defectIssues),
  storyCandidateDefectSignature(7, '老师讲了五颇为钟的课。', detectStoryTextIntegrityIssues('老师讲了五颇为钟的课。'))
)
assert.equal(
  storyHarnessIssueKey({ code: 'TIMELINE_CONTRADICTION', severity: 'blocker', scope: 'engine', chapterIds: [2, 1], evidence: [], message: '时间冲突', expectedResult: '修复' }),
  storyHarnessIssueKey({ code: 'TIMELINE_CONTRADICTION', severity: 'blocker', scope: 'cluster', chapterIds: [1, 2], evidence: [], message: '同一时间冲突', expectedResult: '修复' })
)
assert.notEqual(
  storyHarnessIssueKey({ code: 'DEUS_EX_MACHINA', severity: 'blocker', scope: 'scene', chapterIds: [7], evidence: [], message: '催债短信', expectedResult: '铺垫', identityHint: 'DEBT_MESSAGE_TRIGGER' }),
  storyHarnessIssueKey({ code: 'DEUS_EX_MACHINA', severity: 'blocker', scope: 'scene', chapterIds: [7], evidence: [], message: '天降权威', expectedResult: '铺垫', identityHint: 'OFFICIAL_UNSEEDED_INTERVENTION' })
)

console.log('story harness deterministic tests passed')
