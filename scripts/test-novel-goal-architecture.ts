import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { buildCausalStateSeedProjection } from '../src/main/context/goal-routine/causal-state-seed'
import { resolveNovelDraftWorkflowStep } from '../src/main/context/goal-routine/novel-draft-step'
import { classifyWorkflowError } from '../src/main/workflow/workflow-errors'
import {
  leafFailureContinuationDelay,
  shouldContinueNovelRunAfterLeafFailure
} from '../src/main/context/goal-routine/novel-run-continuation-policy'
import { CausalOutcomeProtocolError } from '../src/shared/causal-outcome-protocol'
import { CAUSAL_STEP_EXECUTION_PROFILE } from '../src/main/context/goal-routine/causal-step-execution-profile'
import {
  CausalPlanningAuthorityMismatchError,
  CausalPlanRefinementExhaustedError
} from '../src/main/context/goal-routine/causal-planning-failure'
import {
  applyExactQualityPatches,
  detectChapterAcceptanceStall,
  novelChapterAcceptanceKey
} from '../src/main/context/goal-routine/novel-chapter-acceptance-policy'
import {
  parseCachedQualityAssessment,
  serializeQualityAssessment
} from '../src/main/context/goal-routine/chapter-assessment-cache'
import { buildNovelWorkflowStepInput } from '../src/main/context/goal-routine/novel-workflow-step-input'
import {
  formatPromptJsonSchemaIssueValue,
  PromptJsonSchemaValidationError,
  validatePromptJsonSchema
} from '../src/shared/prompt-json-schema-validator'
import {
  CausalProgressGateError,
  type CausalNarrativeState
} from '../src/shared/causal-novel-types'
import {
  applyCandidateReferencePatches,
  assertReferencePatches,
  candidateReferenceIssues,
  CausalPlanReferenceRepairExhaustedError
} from '../src/main/context/goal-routine/causal-plan-reference-repair'
import { workflowInputHash } from '../src/main/db/dao/goal-routine-dao'
import { stepAcceptsWorkBodySlotModel } from '../src/shared/step-model-config'
import { CHAPTER_TRANSACTION_MAX_PATCHES } from '../src/main/context/goal-routine/novel-chapter-transaction-policy'
import {
  buildNarrativeMemoryRepairPlan,
  classifyWordRangeRepairAction,
  shouldRouteExecutionContractRepairToStructuralReplan,
  shouldRouteLengthNormalizationToSemanticRepair
} from '../src/main/context/goal-routine/novel-autonomous-control'
import {
  CHAPTER_ACCEPTANCE_MAX_ASSESSMENTS,
  CHAPTER_ACCEPTANCE_MAX_REPAIRS,
  CHAPTER_ACCEPTANCE_PROTOCOL_VERSION
} from '../src/main/context/goal-routine/novel-chapter-acceptance-policy'
import {
  NOVEL_WORKFLOW_DEFINITION_VERSION,
  novelWorkflowStepProtocolVersion,
  resolveNovelWorkflowDefinitionUpgrade
} from '../src/main/context/goal-routine/novel-workflow-definition'
import {
  GOLDEN_THREE_GATE_MAX_ATTEMPTS,
  goldenThreeGateTokenBudget
} from '../src/main/context/goal-routine/novel-golden-three-gate-policy'
import { bodyWordCountBounds, countWords } from '../src/shared/body-word-target'
import { buildChapterExecutionContract } from '../src/shared/chapter-execution-contract'
import {
  applyWordRangePatchPool,
  buildWordRangeSourceSegments,
  wordRangeExpansionPoolContract,
  wordRangePatchPoolCapacity,
  wordRangeSafeBand
} from '../src/main/context/goal-routine/novel-word-range-normalizer'

assert.equal(CHAPTER_ACCEPTANCE_PROTOCOL_VERSION, 3)
assert.equal(CHAPTER_ACCEPTANCE_MAX_ASSESSMENTS, 1)
assert.equal(CHAPTER_ACCEPTANCE_MAX_REPAIRS, 1)
const causalProgressFailure = classifyWorkflowError(
  new CausalProgressGateError('CHAPTER_NO_MATERIAL_PROGRESS')
)
assert.equal(causalProgressFailure.code, 'CAUSAL_PROGRESS_GATE_BLOCKED')
assert.equal(shouldContinueNovelRunAfterLeafFailure({ failure: causalProgressFailure }), false)
const emptyBodyRepairExecutionSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/main/context/goal-routine/novel-repair-execution.ts'),
  'utf8'
)
const emptyBodyGoalRoutineSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/main/context/goal-routine/novel-goal-routine.ts'),
  'utf8'
)
const releaseWindowAuditSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/main/context/goal-routine/novel-release-window-audit.ts'),
  'utf8'
)
assert.match(
  emptyBodyRepairExecutionSource,
  /if \(!chapter\.content\?\.trim\(\)\) \{\s*throw new NovelRepairGenerationRequiredError/,
  '空正文必须被修订入口拒绝，并回到正文生成状态机'
)
assert.match(
  emptyBodyGoalRoutineSource,
  /action: 'empty_body_regeneration_required'/,
  '空正文修订失败必须显式转移到重新生成，而非泛化为修订重试'
)
assert.match(
  emptyBodyGoalRoutineSource,
  /updateNovelGoalState\(workId, \{ repairPlan: undefined, failure: undefined \}\)/,
  '成功执行的修复计划必须消费，不能作为下一轮的陈旧命令重复执行'
)
assert.equal(NOVEL_WORKFLOW_DEFINITION_VERSION, 8)
assert.equal(novelWorkflowStepProtocolVersion('release_window_audit'), 1)
assert.match(
  emptyBodyGoalRoutineSource,
  /phase = resolvePendingNovelReleaseWindow\(workId\) \? 'release_window_audit' : 'draft_body'/,
  '修复完成后必须按新正文哈希重审首发窗口，不能直接继续生成后续章节'
)
assert.match(
  releaseWindowAuditSource,
  /thinkingEnabled: false,[\s\S]*forceThinkingDisabled: true/,
  '首发窗口结构化审读必须禁止隐藏 reasoning 吞掉 JSON 输出预算'
)
assert.match(
  releaseWindowAuditSource,
  /class ReleaseWindowEvidenceValidationError[\s\S]*repairValidationError: \(\{ value, error \}\) => correctReleaseWindowEvidence/,
  '首发窗口证据不定位时必须进入定点证据纠正，而不是重新生成整份评分'
)
assert.match(
  emptyBodyGoalRoutineSource,
  /attemptedPhase === 'release_window_audit'[\s\S]*setStatus\(workId, 'paused'\)[\s\S]*action: 'release_window_audit_terminal'/,
  '首发窗口审读失败必须冻结并暂停，不能进入通用自治重试'
)
assert.equal(novelWorkflowStepProtocolVersion('precommit_artifacts'), 29)
assert.equal(novelWorkflowStepProtocolVersion('body_generation'), 6)
assert.equal(novelWorkflowStepProtocolVersion('repair_execute'), 20)
assert.equal(novelWorkflowStepProtocolVersion('chapter_decision'), 9)
assert.equal(novelWorkflowStepProtocolVersion('causal_state_init'), 7)
assert.equal(novelWorkflowStepProtocolVersion('generate_character_cards'), 7)
assert.equal(novelWorkflowStepProtocolVersion('generate_title_hook'), 7)
assert.equal(GOLDEN_THREE_GATE_MAX_ATTEMPTS, 3)
assert.deepEqual(
  Array.from({ length: GOLDEN_THREE_GATE_MAX_ATTEMPTS }, (_, index) => (
    goldenThreeGateTokenBudget(index + 1)
  )),
  [1600, 3200, 6400]
)
assert.equal(countWords('甲，乙。\n'), 4, '全链路字数口径必须去空白并保留标点')
assert.deepEqual(
  bodyWordCountBounds(2000, 0.4),
  { min: 1200, max: 2800 },
  '章节门禁必须保留用户设置的 40% 容差'
)
assert.deepEqual(
  bodyWordCountBounds(2000, 1.5),
  { min: 0, max: 4000 },
  '章节门禁容差上限必须固定为 100%'
)
const executionContractInput = {
  chapterId: 1,
  chapterTitle: '合同身份测试',
  chapterOrdinal: 1,
  outline: '【必须覆盖】主角推门\n【结尾落点】主角进入房间',
  characterNames: ['主角'],
  wordTarget: 2000
}
const contractAt2000 = buildChapterExecutionContract(executionContractInput)
const contractAt2400 = buildChapterExecutionContract({ ...executionContractInput, wordTarget: 2400 })
assert.notEqual(
  contractAt2000.sourceOutlineHash,
  contractAt2400.sourceOutlineHash,
  '验收凭证必须绑定完整执行合同，字数合同改变时旧凭证必须失效'
)
assert.deepEqual(
  wordRangeSafeBand({ actual: 2785, min: 1500, target: 2000, max: 2500, direction: 'compress' }),
  { min: 2120, max: 2405, preferred: 2263 }
)
assert.deepEqual(
  wordRangeSafeBand({ actual: 2548, min: 1500, target: 2000, max: 2500, direction: 'compress' }),
  { min: 2420, max: 2484, preferred: 2452 },
  '轻微越界必须按实际超出量留安全余量，不能强制向目标字数大幅删改'
)
const lengthSource = '甲甲甲甲。乙乙乙乙。丙丙丙丙。丁丁丁丁。'
const normalizedLength = applyWordRangePatchPool({
  source: lengthSource,
  range: { actual: 20, min: 8, target: 10, max: 12, direction: 'compress' },
  patches: [
    { segmentId: 'seg-0004', operation: 'replace', replace: '丁丁丁丁丁。', reason: '方向错误的候选应被本地选择器剔除' },
    { segmentId: 'seg-0001', operation: 'replace', replace: '甲', reason: '删去重复动作' },
    { segmentId: 'seg-0002', operation: 'replace', replace: '乙', reason: '删去重复解释' },
    { segmentId: 'seg-0003', operation: 'replace', replace: '丙', reason: '删去重复感知' }
  ]
})
assert.ok(normalizedLength.finalWords >= normalizedLength.safeBand.min)
assert.ok(normalizedLength.finalWords <= normalizedLength.safeBand.max)
assert.equal(normalizedLength.applied.length, 3, '本地组合器应只选择进入安全区间所需的补丁子集')
assert.ok(
  normalizedLength.applied.every(patch => patch.segmentId !== 'seg-0004'),
  '候选池中的方向错误补丁不得终止整池，也不得进入原子结果'
)
assert.deepEqual(
  buildWordRangeSourceSegments('重复。重复。').map(segment => [segment.id, segment.text]),
  [['seg-0001', '重复。'], ['seg-0002', '重复。']],
  '相同原文必须由稳定片段 ID 无歧义定位'
)
assert.deepEqual(
  buildWordRangeSourceSegments('“扔出去！”\n三楼不知道谁喊了一声。\n“把他扔出去赔罪！”')
    .map(segment => [segment.id, segment.text]),
  [
    ['seg-0001', '“扔出去！”'],
    ['seg-0002', '三楼不知道谁喊了一声。'],
    ['seg-0003', '“把他扔出去赔罪！”']
  ],
  '标点归属必须由程序从正文切分，模型不再复制原文标点参与定位'
)
assert.throws(
  () => applyWordRangePatchPool({
    source: '甲乙丙丁戊己庚辛',
    range: { actual: 8, min: 3, target: 4, max: 5, direction: 'compress' },
    patches: [
      { segmentId: 'seg-0001', operation: 'replace', replace: '甲', reason: '第一候选' },
      { segmentId: 'seg-0001', operation: 'replace', replace: '戊', reason: '重复候选' }
    ]
  }),
  /重复引用片段/
)
assert.throws(
  () => applyWordRangePatchPool({
    source: '甲乙丙丁戊己庚辛',
    range: { actual: 8, min: 2, target: 3, max: 4, direction: 'compress' },
    patches: [{ segmentId: 'seg-0001', operation: 'replace', replace: '甲乙丙丁戊己庚', reason: '容量不足' }]
  }),
  /容量 1 无法覆盖/
)
assert.throws(
  () => applyWordRangePatchPool({
    source: '甲。乙。',
    range: { actual: 4, min: 1, target: 2, max: 3, direction: 'compress' },
    patches: [{ segmentId: 'seg-9999', operation: 'delete', reason: '不存在的定位' }]
  }),
  /片段不存在/
)
const deletedLength = applyWordRangePatchPool({
  source: '甲甲甲甲。乙乙乙乙。丙丙丙丙。',
  range: { actual: 15, min: 5, target: 7, max: 9, direction: 'compress' },
  patches: [
    { segmentId: 'seg-0001', operation: 'delete', reason: '删除整段重复动作' },
    { segmentId: 'seg-0002', operation: 'delete', reason: '删除整段重复解释' }
  ]
})
assert.equal(deletedLength.content, '丙丙丙丙。', 'delete 操作必须由程序按稳定片段执行整段删除')
const expandedLength = applyWordRangePatchPool({
  source: '甲。乙。',
  range: { actual: 4, min: 7, target: 9, max: 11, direction: 'expand' },
  patches: [
    { segmentId: 'seg-0001', insertAfter: '推门而入。', reason: '补足动作反馈' },
    { segmentId: 'seg-0002', insertAfter: '退后一步。', reason: '补足人物反应' }
  ]
})
assert.ok(expandedLength.finalWords >= expandedLength.safeBand.min)
assert.ok(expandedLength.finalWords <= expandedLength.safeBand.max)
assert.equal(
  expandedLength.content,
  '甲。推门而入。乙。',
  '扩写补丁只能插入新增文本，原片段必须由程序原样保留'
)
assert.ok(
  expandedLength.applied.every(patch => 'insertAfter' in patch && !patch.insertAfter.includes(patch.find)),
  '扩写候选只应持久化新增文本，不得把原片段复制进模型补丁'
)
assert.throws(
  () => applyWordRangePatchPool({
    source: '陈凉蹲在通风管下，先把残纸捡起来。老周攥着扳手守在挡片边。',
    range: { actual: 29, min: 45, target: 49, max: 53, direction: 'expand' },
    patches: [{
      segmentId: 'seg-0002',
      insertAfter: '陈凉蹲在通风管下，先把残纸捡起来。',
      reason: '错误地复制已有动作'
    }]
  }),
  /复制了已有正文句段/,
  '扩写补丁不得靠复制原句进入字数区间'
)
const mixedExpansionSource = '陈凉蹲在通风管下，先把残纸捡起来。老周攥着扳手守在挡片边。'
const mixedExpansionActual = countWords(mixedExpansionSource)
const mixedExpansion = applyWordRangePatchPool({
  source: mixedExpansionSource,
  range: {
    actual: mixedExpansionActual,
    min: mixedExpansionActual + 6,
    target: mixedExpansionActual + 9,
    max: mixedExpansionActual + 12,
    direction: 'expand'
  },
  patches: [
    {
      segmentId: 'seg-0001',
      insertAfter: '陈凉蹲在通风管下，先把残纸捡起来。',
      reason: '错误地复制已有动作'
    },
    {
      segmentId: 'seg-0002',
      insertAfter: '她抬眼看向楼梯口。',
      reason: '补足当前动作反馈'
    }
  ]
})
assert.equal(mixedExpansion.applied.length, 1, '候选池中的无效扩写不得毒化独立有效候选')
assert.equal(mixedExpansion.applied[0].segmentId, 'seg-0002')
assert.doesNotMatch(mixedExpansion.content, /陈凉蹲在通风管下，先把残纸捡起来。陈凉蹲/u)
const partialExpansionPatches = [
  { segmentId: 'seg-0001', insertAfter: '一二三四五六', reason: '第一批局部动作' },
  { segmentId: 'seg-0002', insertAfter: '七八九十甲乙', reason: '第一批局部反馈' }
]
const supplementalExpansionPatches = [
  { segmentId: 'seg-0003', insertAfter: '丙丁戊己庚辛', reason: '补充局部因果过渡' }
]
assert.equal(
  wordRangePatchPoolCapacity({
    source: '甲。乙。丙。丁。',
    direction: 'expand',
    patches: partialExpansionPatches
  }),
  12,
  '结构化响应验收必须按可执行净变化计算候选池容量'
)
assert.deepEqual(
  wordRangeExpansionPoolContract({
    requiredMinCapacity: 532,
    requiredMaxCapacity: 931,
    allowedSegmentCount: 37
  }),
  { patchCount: 6, minPatchWords: 89, maxPatchWords: 155 },
  '扩写池必须把总缺口编译成固定条数与逐条净字数合同'
)
assert.equal(
  classifyWordRangeRepairAction({
    actual: 1101,
    min: 1500,
    target: 2000,
    max: 2500,
    direction: 'expand'
  }),
  'expand',
  '大幅欠长属于正文生成未完成，必须完整重生当前未提交候选'
)
assert.equal(
  classifyWordRangeRepairAction({
    actual: 1410,
    min: 1500,
    target: 2000,
    max: 2500,
    direction: 'expand'
  }),
  'normalize_length',
  '小幅字数偏差仍保留归一化意图，但执行边界必须是正文原子候选'
)
assert.equal(
  shouldContinueNovelRunAfterLeafFailure({
    failure: classifyWorkflowError(new Error('OUTPUT_INVALID: schema mismatch'), 3),
    chapterId: 1898
  }),
  true,
  '结构化候选失败只能拒绝叶子事务，不能终止整轮运行'
)
const releaseWindowBudgetFailure = classifyWorkflowError(new Error(
  'HTTP 200；finishReason=length；contentChars=0；reasoningChars=18606；completionTokens=11999'
))
assert.equal(
  shouldContinueNovelRunAfterLeafFailure({
    failure: releaseWindowBudgetFailure,
    phase: 'release_window_audit'
  }),
  false,
  '首发窗口预算耗尽必须暂停在工作级发布门禁，不能继续整轮循环'
)
assert.equal(
  shouldContinueNovelRunAfterLeafFailure({
    failure: releaseWindowBudgetFailure,
    phase: 'generate_volumes'
  }),
  false,
  '没有章节目标的分卷预算耗尽必须暂停，不能伪装成叶子候选继续'
)
assert.match(
  emptyBodyGoalRoutineSource,
  /scopedChapterId == null[\s\S]*setStatus\(workId, 'paused'\)[\s\S]*action: 'work_level_protocol_terminal'/,
  '工作级协议失败必须持久化终止并暂停'
)
assert.equal(
  shouldContinueNovelRunAfterLeafFailure({
    failure: classifyWorkflowError(new DOMException('已取消', 'AbortError')),
    chapterId: 1898
  }),
  false,
  '显式取消必须由运行监督器尊重'
)
assert.equal(
  leafFailureContinuationDelay(classifyWorkflowError(new Error('ETIMEDOUT'), 3)),
  5000,
  '外部传输耗尽后应保留检查点等待，而不是升级整轮 error'
)
assert.throws(
  () => applyWordRangePatchPool({
    source: '甲。乙。丙。丁。',
    range: { actual: 8, min: 20, target: 24, max: 28, direction: 'expand' },
    patches: partialExpansionPatches
  }),
  /容量 12 无法覆盖/
)
const accumulatedExpansion = applyWordRangePatchPool({
  source: '甲。乙。丙。丁。',
  range: { actual: 8, min: 20, target: 24, max: 28, direction: 'expand' },
  patches: [...partialExpansionPatches, ...supplementalExpansionPatches]
})
assert.equal(accumulatedExpansion.finalWords, 26, '补充池必须与首批有效候选累计后再做一次原子选择')
assert.deepEqual(resolveNovelWorkflowDefinitionUpgrade({
  resume: true,
  phase: 'repair_execute',
  savedVersion: 2,
  hasTargetBody: true
}), { migrated: true, phase: 'draft_body' })
assert.deepEqual(resolveNovelWorkflowDefinitionUpgrade({
  resume: true,
  phase: 'repair_execute',
  savedVersion: NOVEL_WORKFLOW_DEFINITION_VERSION,
  hasTargetBody: true
}), { migrated: false, phase: 'repair_execute' })

const volumes = Array.from({ length: 20 }, (_, index) => ({
  id: index + 1,
  name: `第${index + 1}卷`,
  description: '卷级目标'.repeat(1_000),
  planned_start_chapter: index * 40 + 1,
  planned_end_chapter: (index + 1) * 40
}))
const chapters = Array.from({ length: 800 }, (_, index) => ({
  id: index + 1,
  volume_id: Math.floor(index / 40) + 1,
  title: `第${index + 1}章`,
  outline: '章节大纲'.repeat(1_000),
  next_hook: '下一章钩子'.repeat(200),
  content: null
}))
const projection = buildCausalStateSeedProjection(volumes, chapters)
assert.equal(projection.volumeArcs.length, 20)
assert.equal(projection.activeWindow.length, 8)
assert.equal(projection.activeWindow[0].id, 1)
assert.ok(
  JSON.stringify(projection).length < 55_000,
  '800章初始化输入必须保持有界，禁止再次复制全书逐章规划'
)

const semanticChapter = {
  id: 1817,
  volume_id: 1,
  title: '第一章',
  outline: '既定大纲',
  content: '同一份正文',
  word_count: 6,
  sort: 1,
  status: 'draft',
  emotion_intensity: null,
  beat_role: null,
  foreshadow_target: null,
  next_hook: null,
  pov_mode: null,
  characters: null,
  outline_diagnosis: null,
  emotion_contract_json: null,
  emotion_assessment_json: null,
  quality_assessment_json: null,
  create_time: '2026-01-01 00:00:00',
  update_time: '2026-01-01 00:00:00'
}
const stepInput = (chapter: typeof semanticChapter) => buildNovelWorkflowStepInput({
  phase: 'repair_execute',
  operation: 'repair_execute',
  stateRevision: 1,
  pendingReplayJobId: null,
  repairPlan: { action: 'quality', targetChapterIds: [1817] },
  chapters: [chapter],
  scopedChapterId: 1817
})
assert.equal(
  workflowInputHash(stepInput(semanticChapter)),
  workflowInputHash(stepInput({
    ...semanticChapter,
    update_time: '2026-01-02 00:00:00',
    word_count: 999,
    quality_assessment_json: '{"score":82}'
  })),
  '评测时间、缓存与派生字数不得改变工作流步骤身份'
)
assert.notEqual(
  workflowInputHash(stepInput(semanticChapter)),
  workflowInputHash(stepInput({ ...semanticChapter, content: '正文事实已改变' })),
  '正文改变必须产生新的步骤输入身份'
)

const evidenceClaimSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['claim', 'evidenceIds'],
  properties: {
    claim: { type: 'string', minLength: 1 },
    evidenceIds: { type: 'array', minItems: 1, items: { type: 'string' } }
  }
}
assert.throws(
  () => validatePromptJsonSchema('被错误压平的压力来源', evidenceClaimSchema),
  PromptJsonSchemaValidationError,
  'prompt_json 必须在本地拒绝丢失 evidenceIds 的压平字段'
)
validatePromptJsonSchema({ claim: '楼道脚步声', evidenceIds: ['e0103'] }, evidenceClaimSchema)
validatePromptJsonSchema(null, { type: ['string', 'null'] })
assert.throws(
  () => validatePromptJsonSchema(42, { type: ['string', 'null'] }),
  PromptJsonSchemaValidationError
)
validatePromptJsonSchema({ kind: 'a' }, {
  anyOf: [
    { type: 'object', required: ['kind'], properties: { kind: { const: 'a' } } },
    { type: 'object', required: ['other'], properties: { other: { type: 'string' } } }
  ]
})

let enumDiagnostic: PromptJsonSchemaValidationError | undefined
try {
  validatePromptJsonSchema('promise_missing', { type: 'string', enum: ['p1', 'p2'] })
} catch (error) {
  if (error instanceof PromptJsonSchemaValidationError) enumDiagnostic = error
}
assert.equal(enumDiagnostic?.path, '$')
assert.equal(enumDiagnostic?.issue?.kind, 'enum')
assert.equal(enumDiagnostic?.issue?.actual, 'promise_missing')
assert.deepEqual(enumDiagnostic?.issue?.allowed, ['p1', 'p2'])
assert.equal(
  formatPromptJsonSchemaIssueValue(undefined, 240),
  'undefined',
  '缺失 required 字段的 actual=undefined 必须可诊断，不能在错误格式化阶段再次抛错'
)
assert.equal(
  formatPromptJsonSchemaIssueValue(Symbol('missing'), 240),
  'Symbol(missing)',
  'Schema issue actual 的 unknown 合同必须覆盖 JSON.stringify 返回 undefined 的全部值域'
)
assert.equal(formatPromptJsonSchemaIssueValue(['p1', 'p2'], 600), '["p1","p2"]')

const referenceState = {
  actors: [{ name: '林舟' }, { name: '周叔' }],
  activePressures: [{ id: 'pressure_1', status: 'active' }],
  promises: [{ id: 'p1', status: 'open' }, { id: 'p2', status: 'open' }]
} as unknown as CausalNarrativeState
const frozenCandidates = [{
  chapterFunction: 'advance' as const,
  initiator: '林舟',
  action: '追查发动机账目',
  opposition: '账页被撕走',
  cost: '暴露调查意图',
  irreversibleChange: '确认账目存在第二份副本',
  promiseAdvanced: 'promise_missing',
  newQuestion: '副本在谁手里'
}]
const referenceIssues = candidateReferenceIssues(referenceState, frozenCandidates)
assert.deepEqual(referenceIssues.map(issue => issue.path), ['candidates[0].promiseAdvanced'])
assert.throws(
  () => assertReferencePatches(referenceIssues, [{
    path: 'candidates[0].promiseAdvanced',
    value: ['p1', 'p2']
  }]),
  /仍不在当前权威集合中/
)
const reboundCandidates = applyCandidateReferencePatches(referenceState, frozenCandidates, [{
  path: 'candidates[0].promiseAdvanced',
  value: 'p1'
}])
assert.equal(reboundCandidates[0].promiseAdvanced, 'p1')
assert.equal(reboundCandidates[0].action, frozenCandidates[0].action)
assert.equal(reboundCandidates[0].irreversibleChange, frozenCandidates[0].irreversibleChange)
assert.equal(frozenCandidates[0].promiseAdvanced, 'promise_missing', '定点修复不得修改冻结输入对象')
assert.throws(
  () => applyCandidateReferencePatches(referenceState, frozenCandidates, [{
    path: 'candidates[0].action',
    value: '改写候选行动'
  }]),
  /未授权路径/
)
assert.deepEqual(
  classifyWorkflowError(new CausalPlanReferenceRepairExhaustedError('补丁仍引用 promise_missing')),
  {
    errorClass: 'deterministic_invariant',
    code: 'PLAN_REFERENCE_REPAIR_EXHAUSTED',
    message: '权威引用定点修复预算已耗尽：补丁仍引用 promise_missing',
    retryable: false,
    retryDelayMs: 0,
    route: 'pause'
  }
)

assert.equal(resolveNovelDraftWorkflowStep({
  hasCausalState: false,
  decisionReady: false,
  needsGeneration: true,
  needsAcceptance: true,
  precommitReady: false
}), 'causal_state_init')
assert.equal(resolveNovelDraftWorkflowStep({
  hasCausalState: true,
  decisionReady: false,
  needsGeneration: true,
  needsAcceptance: true,
  precommitReady: false
}), 'chapter_decision')
assert.equal(resolveNovelDraftWorkflowStep({
  hasCausalState: true,
  decisionReady: true,
  needsGeneration: true,
  needsAcceptance: true,
  precommitReady: false
}), 'body_generation')
assert.equal(resolveNovelDraftWorkflowStep({
  hasCausalState: true,
  decisionReady: true,
  needsGeneration: false,
  needsAcceptance: true,
  precommitReady: false
}), 'body_acceptance')
assert.equal(resolveNovelDraftWorkflowStep({
  hasCausalState: true,
  decisionReady: true,
  needsGeneration: false,
  needsAcceptance: false,
  precommitReady: false
}), 'precommit_artifacts')
assert.equal(resolveNovelDraftWorkflowStep({
  hasCausalState: true,
  decisionReady: true,
  needsGeneration: false,
  needsAcceptance: false,
  precommitReady: true
}), 'chapter_commit')

const capabilityFailure = classifyWorkflowError(
  new Error('This response_format type is unavailable now')
)
assert.equal(capabilityFailure.errorClass, 'user_action_required')
assert.equal(capabilityFailure.code, 'MODEL_CAPABILITY_UNSUPPORTED')
assert.equal(capabilityFailure.retryable, false)

const prerequisiteError = Object.assign(
  new Error('分卷规划缺少作品级权威状态'),
  { name: 'NovelPipelineError', code: 'PREREQUISITE_MISSING' }
)
const prerequisiteFailure = classifyWorkflowError(prerequisiteError)
assert.equal(prerequisiteFailure.errorClass, 'semantic_contract')
assert.equal(prerequisiteFailure.code, 'PREREQUISITE_MISSING')
assert.equal(prerequisiteFailure.retryable, false)

const authorityMismatchFailure = classifyWorkflowError(
  new CausalPlanningAuthorityMismatchError({
    workId: 49,
    chapterId: 1817,
    stateRevision: 0,
    contractHash: 'chapter-contract',
    reasons: ['当前状态已经越过本章开场']
  })
)
assert.equal(authorityMismatchFailure.code, 'PLAN_AUTHORITY_STATE_MISMATCH')
assert.equal(authorityMismatchFailure.route, 'rebase_authority')
assert.equal(authorityMismatchFailure.retryable, false)
const refinementFailure = classifyWorkflowError(
  new CausalPlanRefinementExhaustedError(1817, ['候选持续新增合同外事件'])
)
assert.equal(refinementFailure.code, 'PLAN_REFINEMENT_EXHAUSTED')
assert.equal(refinementFailure.route, 'pause')
assert.equal(refinementFailure.retryable, false)

const outcomeProtocolFailure = classifyWorkflowError(
  new CausalOutcomeProtocolError(
    'OUTCOME_OPERATION',
    'relationships 不支持 set 操作'
  )
)
assert.equal(outcomeProtocolFailure.errorClass, 'deterministic_invariant')
assert.equal(outcomeProtocolFailure.code, 'OUTCOME_OPERATION')
assert.equal(outcomeProtocolFailure.route, 'pause')
assert.equal(outcomeProtocolFailure.retryable, false)

const outcomeTransportFailure = classifyWorkflowError(
  new CausalOutcomeProtocolError('OUTCOME_TRANSPORT', '网络超时')
)
assert.equal(outcomeTransportFailure.errorClass, 'transient_transport')
assert.equal(outcomeTransportFailure.route, 'retry_step')
assert.equal(outcomeTransportFailure.retryable, true)
const exhaustedOutcomeTransport = classifyWorkflowError(
  new CausalOutcomeProtocolError('OUTCOME_TRANSPORT', '网络超时'),
  3
)
assert.equal(exhaustedOutcomeTransport.errorClass, 'budget_exhausted')
assert.equal(exhaustedOutcomeTransport.code, 'OUTCOME_TRANSPORT_EXHAUSTED')
assert.equal(exhaustedOutcomeTransport.route, 'pause')

const outcomeBudgetFailure = classifyWorkflowError(
  new CausalOutcomeProtocolError('OUTCOME_BUDGET', '章后结果预算耗尽')
)
assert.equal(outcomeBudgetFailure.errorClass, 'budget_exhausted')
assert.equal(outcomeBudgetFailure.route, 'pause')
assert.equal(outcomeBudgetFailure.retryable, false)

const bodyContractFailure = classifyWorkflowError(
  new CausalOutcomeProtocolError(
    'OUTCOME_BODY_CONTRACT',
    '正文没有支持必要状态变更'
  )
)
assert.equal(bodyContractFailure.errorClass, 'semantic_contract')
assert.equal(bodyContractFailure.retryable, false)
assert.equal(bodyContractFailure.route, 'repair_upstream')

const narrativeMemoryGateFailure = classifyWorkflowError(Object.assign(
  new Error('跨章状态/模式：连续蓄力导致读者承诺长期不兑现'),
  { code: 'NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED' }
))
assert.equal(narrativeMemoryGateFailure.errorClass, 'semantic_contract')
assert.equal(narrativeMemoryGateFailure.retryable, false)
assert.equal(narrativeMemoryGateFailure.route, 'repair_upstream')

for (const profile of Object.values(CAUSAL_STEP_EXECUTION_PROFILE)) {
  assert.equal(profile.forceThinkingDisabled, true)
}

const reasoningBudgetFailure = classifyWorkflowError(new Error(
  'HTTP 200；finishReason=length；contentChars=0；reasoningChars=8477；completionTokens=2600'
))
assert.equal(reasoningBudgetFailure.errorClass, 'budget_exhausted')
assert.equal(reasoningBudgetFailure.code, 'REASONING_BUDGET_EXHAUSTED')
assert.equal(reasoningBudgetFailure.retryable, false)
assert.equal(reasoningBudgetFailure.route, 'pause')

const nonConvergentError = Object.assign(
  new Error('章节自动修订未收敛'),
  { name: 'NovelPipelineError', code: 'QUALITY_NON_CONVERGENT' }
)
const nonConvergentFailure = classifyWorkflowError(nonConvergentError)
assert.equal(nonConvergentFailure.errorClass, 'deterministic_invariant')
assert.equal(nonConvergentFailure.code, 'QUALITY_NON_CONVERGENT')
assert.equal(nonConvergentFailure.retryable, false)
assert.equal(nonConvergentFailure.route, 'pause')

const chapterSkeletonProtocolFailure = classifyWorkflowError(Object.assign(
  new Error('连续 3 次结构化输出无效：OUTPUT_INVALID: 状态增量 Schema 校验失败'),
  { name: 'NovelPipelineError', code: 'CHAPTER_SKELETON_PROTOCOL_EXHAUSTED' }
))
assert.equal(chapterSkeletonProtocolFailure.errorClass, 'deterministic_invariant')
assert.equal(chapterSkeletonProtocolFailure.retryable, false)
assert.equal(chapterSkeletonProtocolFailure.route, 'pause')

const repairGateSubclassError = Object.assign(
  new Error('修订候选未通过 emotion 门禁：情绪门禁 79分/scene层'),
  { name: 'NovelRepairGateError', code: 'EMOTION_NON_CONVERGENT' }
)
const repairGateSubclassFailure = classifyWorkflowError(repairGateSubclassError)
assert.equal(repairGateSubclassFailure.errorClass, 'deterministic_invariant')
assert.equal(repairGateSubclassFailure.code, 'EMOTION_NON_CONVERGENT')
assert.equal(repairGateSubclassFailure.retryable, false)
assert.equal(repairGateSubclassFailure.route, 'pause')

const patchExhaustedFailure = classifyWorkflowError(Object.assign(
  new Error('唯一一次硬合同补丁已使用'),
  { code: 'CHAPTER_TRANSACTION_PATCH_EXHAUSTED' }
))
assert.equal(CHAPTER_TRANSACTION_MAX_PATCHES, 1)
assert.equal(shouldRouteLengthNormalizationToSemanticRepair({
  attemptedPhase: 'repair_execute',
  attemptedAction: 'normalize_length',
  blockedGate: 'execution_contract'
}), true, '字数车道完成后首次暴露执行合同阻断，必须转入独立语义车道')
assert.equal(shouldRouteLengthNormalizationToSemanticRepair({
  attemptedPhase: 'repair_execute',
  attemptedAction: 'execution_contract',
  blockedGate: 'execution_contract'
}), false, '语义车道失败不得借正交路由获得第二次语义补丁')
assert.equal(shouldRouteLengthNormalizationToSemanticRepair({
  attemptedPhase: 'repair_execute',
  attemptedAction: 'normalize_length',
  blockedGate: 'emotion'
}), false, '正交路由只能处理章节执行硬合同')
assert.equal(shouldRouteExecutionContractRepairToStructuralReplan({
  attemptedPhase: 'repair_execute',
  attemptedAction: 'execution_contract',
  blockedGate: 'execution_contract',
  previousEvidenceFingerprint: 'before',
  failedMetrics: ['章节合同：提前越界']
}), true, '执行合同补丁暴露新证据时必须转入独立结构重规划')
assert.equal(shouldRouteExecutionContractRepairToStructuralReplan({
  attemptedPhase: 'repair_execute',
  attemptedAction: 'execution_contract',
  blockedGate: 'execution_contract',
  previousEvidenceFingerprint: undefined,
  failedMetrics: ['章节合同：提前越界']
}), false, '缺少上一次可审计证据时不得猜测为结构重规划')
assert.equal(patchExhaustedFailure.errorClass, 'deterministic_invariant')
assert.equal(patchExhaustedFailure.route, 'pause')
const hardGateProtocolFailure = classifyWorkflowError(Object.assign(
  new Error('章节硬合同评估器未返回有效证据'),
  { code: 'EVALUATOR_PROTOCOL' }
))
assert.equal(hardGateProtocolFailure.errorClass, 'deterministic_invariant')
assert.equal(hardGateProtocolFailure.route, 'pause')

const patched = applyExactQualityPatches(
  '他推开门。屋里没有人。',
  [{ find: '屋里没有人', replace: '屋里只剩一盏摇晃的灯' }]
)
assert.equal(patched.success, true)
assert.equal(patched.content, '他推开门。屋里只剩一盏摇晃的灯。')
assert.equal(
  applyExactQualityPatches('他看着门。他看着门。', [{ find: '他看着门', replace: '他推门' }]).success,
  false,
  '证据片段不唯一时必须整批拒绝'
)
assert.equal(
  detectChapterAcceptanceStall([
    { contentHash: 'a', blockingFailures: ['逻辑'], scoreTotal: 70 },
    { contentHash: 'b', blockingFailures: ['逻辑'], scoreTotal: 70 },
    { contentHash: 'c', blockingFailures: ['逻辑'], scoreTotal: 71 }
  ])?.code,
  'PLATEAU'
)
assert.equal(
  detectChapterAcceptanceStall([
    { contentHash: 'a', blockingFailures: ['逻辑'], scoreTotal: 70 },
    { contentHash: 'b', blockingFailures: ['逻辑'], scoreTotal: 71 },
    { contentHash: 'a', blockingFailures: ['逻辑'], scoreTotal: 70 }
  ])?.code,
  'TWO_CYCLE'
)
assert.equal(
  novelChapterAcceptanceKey({
    workId: 1,
    chapterId: 2,
    baseContentHash: 'body',
    contractHash: 'contract'
  }),
  novelChapterAcceptanceKey({
    workId: 1,
    chapterId: 2,
    baseContentHash: 'body',
    contractHash: 'contract'
  }),
  '同一基础正文与合同必须得到稳定验收身份'
)
const authorAcceptedCache = parseCachedQualityAssessment(
  serializeQualityAssessment({
    content: '作者确认正文',
    scoreTotal: 72,
    hardFail: false,
    report: '模型争议证据',
    acceptedByAuthor: true,
    authorNote: '作者核对前后文后确认因果成立'
  }),
  '作者确认正文'
)
assert.equal(authorAcceptedCache?.acceptedByAuthor, true)
assert.equal(authorAcceptedCache?.authorNote, '作者核对前后文后确认因果成立')

const acceptanceSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/novel-chapter-acceptance.ts'),
  'utf8'
)
assert.doesNotMatch(acceptanceSource, /function countWords\(/)
assert.match(acceptanceSource, /from '\.\.\/\.\.\/\.\.\/shared\/body-word-target'/)
assert.equal(acceptanceSource.includes('reviseBeatBody('), false)
assert.equal(acceptanceSource.includes('repairNovelExecutionCandidate('), false)
assert.equal(acceptanceSource.includes("step: 'goal_diagnose_fix'"), false)
const storyGoalDoerCanonicalWordSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-goal-doer.ts'),
  'utf8'
)
assert.doesNotMatch(storyGoalDoerCanonicalWordSource, /function countWords\(/)
const persistBodySource = storyGoalDoerCanonicalWordSource.slice(
  storyGoalDoerCanonicalWordSource.indexOf('async function persistGeneratedBody'),
  storyGoalDoerCanonicalWordSource.indexOf('export async function commitStoryBodyCandidate')
)
assert.ok(
  persistBodySource.indexOf('requiredWordRange')
    < persistBodySource.indexOf('volumeChapterDAO.updateChapterWithVersion'),
  '字数修复候选必须先通过统一后置条件，之后才能持久化'
)
const evidenceRepairSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/novel-chapter-evidence-repair.ts'),
  'utf8'
)
assert.match(evidenceRepairSource, /禁止返回完整正文/)
assert.match(evidenceRepairSource, /applyExactQualityPatches/)
const goalRoutinePanelSource = fs.readFileSync(
  path.resolve('src/renderer/src/views/editor/GoalRoutinePanel.vue'),
  'utf8'
)
assert.equal(
  goalRoutinePanelSource.includes('window.prompt('),
  false,
  'Electron 交互不得使用不受支持的 window.prompt'
)
assert.equal(goalRoutinePanelSource.includes('authorAcceptanceDialogOpen'), false)
assert.equal(goalRoutinePanelSource.includes('确认并写入验收账本'), false)
assert.match(goalRoutinePanelSource, /自治周期上限/)
assert.match(goalRoutinePanelSource, /无需人工参与/)
assert.match(goalRoutinePanelSource, /config\.checkEmotionContract/)
assert.match(goalRoutinePanelSource, /config\.checkEmotionGate/)
assert.match(goalRoutinePanelSource, /启用情绪合同校验/)
assert.match(goalRoutinePanelSource, /启用情绪门禁校验/)
const canResumeSource = goalRoutinePanelSource.slice(
  goalRoutinePanelSource.indexOf('const canResume = computed'),
  goalRoutinePanelSource.indexOf('const resumeLabel = computed')
)
assert.doesNotMatch(
  canResumeSource,
  /unchangedAcceptanceBlock/,
  '正式运行断点的可恢复性必须由运行状态决定，旧验收展示状态不得隐藏断点续跑入口'
)
const repeatedHookPlan = buildNarrativeMemoryRepairPlan(1893, [
  '跨章状态/模式[REPEATED_HOOK]：连续章节重复使用相同章末钩子'
])
assert.equal(repeatedHookPlan.action, 'cluster')
assert.equal(repeatedHookPlan.scope, 'cluster')
assert.deepEqual(repeatedHookPlan.targetChapterIds, [1893])
assert.ok(repeatedHookPlan.issueCodes?.includes('NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED'))
const autonomousControlSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/novel-autonomous-control.ts'),
  'utf8'
)
assert.doesNotMatch(
  autonomousControlSource,
  /reserveChapterTransactionPatch/,
  '计划构建与断点协调不得提前消耗章节补丁事务'
)
assert.match(autonomousControlSource, /requiresOutlineReplan \? 'cluster' : 'systemic'/)
assert.match(autonomousControlSource, /跨章状态\/模式\[REPEATED_HOOK\]/)
assert.match(autonomousControlSource, /dramatic_contract\.next_question/)
assert.match(autonomousControlSource, /narrative_memory_outline_replan/)
assert.match(autonomousControlSource, /supersedeEpisode\(acceptance\.id\)/)
assert.match(
  autonomousControlSource,
  /acceptedCandidate\.content_hash !== currentContentHash/,
  '普通正文提交的记忆门禁必须由验收账本与当前正文哈希恢复，不得依赖修复专用检查点'
)
assert.match(autonomousControlSource, /repairCommitPending: undefined/)
assert.doesNotMatch(autonomousControlSource, /scope = 'volume'/)
const unifiedRepairSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/unified-novel-repair.ts'),
  'utf8'
)
assert.match(unifiedRepairSource, /discardUnifiedNovelRepairCandidate/)
assert.match(unifiedRepairSource, /contentVersionId: context\.sourceVersionId/)
assert.match(
  unifiedRepairSource,
  /if \(context\.decisionStatus === 'planned'\) \{[\s\S]*?commitUnifiedNovelChapter[\s\S]*?return \{ \.\.\.committed[\s\S]*?\}[\s\S]*?causalNovelDAO\.invalidateCheckpoints/,
  'planned 修复不得在纯提交前删除当前正文版本的预提交制品'
)
const repairExecutionSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/novel-repair-execution.ts'),
  'utf8'
)
assert.match(repairExecutionSource, /NovelRepairGateError/)
assert.match(repairExecutionSource, /settleRejectedRepairCandidate\(repairContext\)/)
assert.match(
  repairExecutionSource,
  /if \(context\.decisionStatus === 'committed'\) \{[\s\S]*?discardUnifiedNovelRepairCandidate\(context\)[\s\S]*?status: 'draft'/,
  '已提交权威候选失败必须回滚，未提交工作候选必须留给下一正交门禁继续修复'
)
assert.match(repairExecutionSource, /findLatestWordCompliantCandidate/)
assert.match(repairExecutionSource, /repairCommitPending/)
assert.match(repairExecutionSource, /resumeAcceptedRepairCommit/)
assert.match(repairExecutionSource, /beforePersist: \(\) => reserveChapterTransactionPatch/)
assert.doesNotMatch(repairExecutionSource, /normalizeNovelChapterWordRange/)
assert.doesNotMatch(repairExecutionSource, /commitNovelBodyCandidate/)
assert.match(
  repairExecutionSource,
  /plan\.action === 'normalize_length'[\s\S]*?完整重写当前未提交正文[\s\S]*?reviseBeatBody/,
  '字数修复必须以冻结章节合同为边界整体重写正文，禁止恢复补丁池执行路径'
)
const structuralRepairSource = repairExecutionSource.slice(
  repairExecutionSource.indexOf('async function reviseNovelStructuralCluster'),
  repairExecutionSource.indexOf('async function reviseCommittedDependencyClosure')
)
assert.match(
  structuralRepairSource,
  /const persist = \(\): \{ outlines: number; invalidatedBodies: number \} => \{[\s\S]*?beforePersist\?\.\(\)[\s\S]*?updateChapterWithVersion/,
  '结构补丁预算只能在完整候选校验后与大纲持久化同一事务消费'
)
assert.match(structuralRepairSource, /database\.transaction\(persist\)/)
assert.match(
  repairExecutionSource,
  /plan\.action === 'systemic' \|\| plan\.action === 'cluster'[\s\S]*?NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED[\s\S]*?repairCommitPending: undefined[\s\S]*?return null/,
  '跨章记忆系统修复必须废弃旧提交检查点并生成新正文或重规划结构'
)
assert.doesNotMatch(repairExecutionSource, /NovelRepairWordRangeError/)
assert.match(repairExecutionSource, /runChapterConvergenceGate/)
assert.match(repairExecutionSource, /persistChapterExecutionContract/)
assert.match(
  repairExecutionSource,
  /step: 'story_repair_blueprint'[\s\S]*?thinkingEnabled: false,[\s\S]*?forceThinkingDisabled: true/,
  '确定性结构重规划必须关闭推理输出，避免推理耗尽正文预算'
)
assert.match(repairExecutionSource, /name: 'novel_structural_replan'/)
assert.match(repairExecutionSource, /schema: responseSchema,[\s\S]*?strict: true/)
assert.match(repairExecutionSource, /validatePromptJsonSchema\(parsed, responseSchema\)/)
assert.match(repairExecutionSource, /required: \['level', 'payoff_type'\]/)
assert.match(repairExecutionSource, /diagnosis\.dramatic_contract = dramatic/)
assert.doesNotMatch(
  repairExecutionSource.slice(
    repairExecutionSource.indexOf("step: 'story_repair_blueprint'"),
    repairExecutionSource.indexOf('const json = extractJsonText')
  ),
  /"tension_level"/,
  '结构重规划提示、Schema 与持久化必须共用唯一的 tension_plan 合同'
)
assert.match(repairExecutionSource, /dramatic_contract: diagnosis\.dramatic_contract/)
assert.match(repairExecutionSource, /title是只读展示字段，不需要返回/)
assert.doesNotMatch(
  repairExecutionSource.slice(
    repairExecutionSource.indexOf('async function reviseNovelStructuralCluster'),
    repairExecutionSource.indexOf('async function reviseCommittedDependencyClosure')
  ),
  /String\(row\.title/,
  '结构重规划不得因模型回显展示标题差异拒绝具备稳定id的目标'
)
assert.doesNotMatch(
  repairExecutionSource.slice(
    repairExecutionSource.indexOf('async function reviseNovelStructuralCluster'),
    repairExecutionSource.indexOf('async function reviseCommittedDependencyClosure')
  ),
  /outline_diagnosis: chapter\.outline_diagnosis/,
  '结构重规划输入不得携带整块重复诊断文本'
)
assert.match(repairExecutionSource, /requiredWordRange: requiredWordRange|requiredWordRange,/)
assert.match(acceptanceSource, /status: 'deferred'/)
assert.match(acceptanceSource, /recordChapterEditorialDebt/)
assert.match(acceptanceSource, /MAX_CHAPTER_CONVERGENCE_ROUNDS = 1/)
assert.doesNotMatch(
  acceptanceSource.slice(acceptanceSource.indexOf('export async function runChapterConvergenceGate')),
  /最终合同复验证据格式无效，正在重新取证/,
  '章节硬合同验证不得在同一事务内重复调用评估器'
)
const novelGoalRoutineSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/novel-goal-routine.ts'),
  'utf8'
)
assert.match(novelGoalRoutineSource, /attemptedPhase === 'repair_execute'/)
assert.doesNotMatch(novelGoalRoutineSource, /terminateNovelRepairReentry/)
assert.match(novelGoalRoutineSource, /handleNarrativeMemoryCommitGate/)
assert.match(
  novelGoalRoutineSource,
  /workflowStepFailure\.code === 'NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED'[\s\S]*?handleNarrativeMemoryCommitGate/,
  '跨章记忆门禁必须按稳定错误码归还记忆域，不得依赖当前 UI 阶段'
)
assert.match(novelGoalRoutineSource, /recoverInterruptedNarrativeMemoryGateOnResume/)
assert.match(
  autonomousControlSource,
  /recoveredByLaterRepair[\s\S]*?step\.step_key === 'repair_execute'[\s\S]*?step\.status === 'completed'[\s\S]*?if \(recoveredByLaterRepair\) return null/,
  '已完成记忆域结构修复后，较早的记忆故障不得再次夺取后续断点恢复权'
)
assert.doesNotMatch(novelGoalRoutineSource, /action: 'protocol_retry'/)
assert.match(novelGoalRoutineSource, /classifiedFailureCount === 1/)
assert.match(novelGoalRoutineSource, /action: 'transport_supervisor_continue'/)
assert.match(novelGoalRoutineSource, /action: 'response_protocol_supervisor_continue'/)
assert.match(novelGoalRoutineSource, /action: 'leaf_failure_supervisor_continue'/)
assert.ok(
  novelGoalRoutineSource.indexOf('const terminal = classifyNovelConstructionOutputTerminal')
    < novelGoalRoutineSource.indexOf("action: 'response_protocol_supervisor_continue'"),
  '章节构建输出截断必须在通用响应协议继续策略之前暂停'
)
assert.match(novelGoalRoutineSource, /action: 'repair_supervisor_continue'/)
assert.match(novelGoalRoutineSource, /action: 'phase_failure_supervisor_continue'/)
assert.doesNotMatch(novelGoalRoutineSource, /action: 'transport_terminal'/)
assert.doesNotMatch(novelGoalRoutineSource, /action: 'response_protocol_terminal'/)
assert.doesNotMatch(novelGoalRoutineSource, /action: 'repair_stall_terminal'/)
assert.doesNotMatch(novelGoalRoutineSource, /action: 'autonomous_failure_terminal'/)
assert.match(novelGoalRoutineSource, /reconcileNovelWorkflowDefinition/)
assert.doesNotMatch(autonomousControlSource, /禁止 repair_execute 自循环/)
const acceptedRepairCommitSource = repairExecutionSource.slice(
  repairExecutionSource.indexOf('async function commitAcceptedRepairCandidate'),
  repairExecutionSource.indexOf('async function resumeAcceptedRepairCommit')
)
assert.match(acceptedRepairCommitSource, /const committed = await commitUnifiedNovelRepair\(/)
assert.doesNotMatch(
  acceptedRepairCommitSource,
  /const committed = await commitAcceptedRepairCandidate\(/,
  '已验收修复候选必须调用唯一权威提交边界，禁止无界自递归'
)
const convergenceSource = acceptanceSource.slice(
  acceptanceSource.indexOf('export async function runChapterConvergenceGate'),
  acceptanceSource.indexOf('export function', acceptanceSource.indexOf('export async function runChapterConvergenceGate') + 1)
)
assert.doesNotMatch(
  convergenceSource,
  /prepareUnifiedNovelChapterCommit/,
  '正文验收边界不得调用记忆或因果预提交模型'
)
const planningRecoverySource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/causal-planning-recovery.ts'),
  'utf8'
)
assert.match(planningRecoverySource, /previous\?\.chapterId === mismatch\.chapterId/)
assert.match(planningRecoverySource, /PLAN_AUTHORITY_RECOVERY_EXHAUSTED/)
assert.match(planningRecoverySource, /strategy: 'state_rebase'/)
assert.match(planningRecoverySource, /strategy: 'chapter_contract_replan'/)
const causalEngineSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/causal-novel-engine.ts'),
  'utf8'
)
assert.match(causalEngineSource, /failureLayer: 'none' \| 'authority_state' \| 'candidate' \| 'decision'/)
assert.doesNotMatch(causalEngineSource, /MAX_CAUSAL_PLAN_AUDIT_REFINEMENTS/)
assert.doesNotMatch(causalEngineSource, /auditRefinementRound|auditFeedback: audit\.reasons/)
assert.doesNotMatch(
  causalEngineSource,
  /mustCover:\s*\{[^}]*maxItems/,
  '因果决策传输 Schema 不得用数量上限拦截随后由权威章节合同绑定的 mustCover'
)
assert.doesNotMatch(
  causalEngineSource,
  /properties\.candidates\.items\.properties\.(?:initiator|promiseAdvanced)\.enum/,
  '因果候选传输 Schema 不得直接绑定动态权威 ID'
)
assert.match(causalEngineSource, /repairCandidateReferences/)
assert.match(causalEngineSource, /repairDecisionReferences/)
assert.match(causalEngineSource, /requestStructuredModelOutput/)
assert.match(
  causalEngineSource,
  /candidates:\s*\{\s*type: 'array', minItems: 3, maxItems: 3/,
  '候选传输合同必须固定为三个互斥事件，避免把候选阶段退化成多份正文草稿'
)
assert.match(
  causalEngineSource,
  /action: \{ type: 'string', minLength: 1, maxLength: 180 \}/,
  '候选行动必须是有界事件合同，不得占用正文级输出预算'
)
assert.match(causalEngineSource, /候选是供服务端决策的事件合同，不是正文草稿/)
const activePlanningSource = causalEngineSource.slice(
  causalEngineSource.indexOf('export async function planNextCausalChapter'),
  causalEngineSource.indexOf('export async function extractCausalOutcome')
)
assert.doesNotMatch(activePlanningSource, /step: 'goal_novel_causal_candidate_scoring'/)
assert.doesNotMatch(activePlanningSource, /step: 'goal_novel_causal_decision_audit'/)
assert.doesNotMatch(activePlanningSource, /return planNextCausalChapter\(/)
assert.match(activePlanningSource, /服务端按生成器冻结顺序建立确定性候选权重/)
assert.equal(
  repairExecutionSource.includes('runChapterAcceptanceGate'),
  false,
  '修复候选必须通过质量、情绪和最终章节合同联合门禁'
)
const causalOutcomePipelineSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/causal-outcome-pipeline.ts'),
  'utf8'
)
const wordRangeNormalizerSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/novel-word-range-normalizer.ts'),
  'utf8'
)
assert.match(wordRangeNormalizerSource, /label: input\.label,[\s\S]*attempts: 2/)
assert.match(
  wordRangeNormalizerSource,
  /validate: value => \{[\s\S]*wordRangePatchPoolCapacity\([\s\S]*capacity < input\.requiredMinCapacity/
)
assert.match(wordRangeNormalizerSource, /字数补丁池可执行容量/)
assert.match(wordRangeNormalizerSource, /上次候选池合同无效/)
assert.match(wordRangeNormalizerSource, /章节字数补丁补充池/)
assert.match(wordRangeNormalizerSource, /patches: \[\.\.\.primaryPatches, \.\.\.supplementalPatches\]/)
assert.match(wordRangeNormalizerSource, /【现有候选组合缺口】/)
assert.match(wordRangeNormalizerSource, /字数补充池重复引用已保留片段/)
assert.match(
  wordRangeNormalizerSource.slice(
    wordRangeNormalizerSource.indexOf('function wordRangePatchSchema'),
    wordRangeNormalizerSource.indexOf('export function wordRangeSafeBand')
  ),
  /maxItems: expansionContract\.patchCount/
)
assert.match(wordRangeNormalizerSource, /每条 insertAfter 的净字数必须在/)
assert.match(wordRangeNormalizerSource, /patchWords < input\.expansionContract\.minPatchWords/)
assert.match(repairExecutionSource, /classifyWordRangeRepairAction\(plan\.wordRange\)/)
assert.match(repairExecutionSource, /废弃补丁式填充/)
assert.match(wordRangeNormalizerSource, /enum: allowedSegmentIds/)
assert.match(wordRangeNormalizerSource, /supplementalSegmentIds = sourceSegmentIds\.filter/)
assert.match(wordRangeNormalizerSource, /\.filter\(segment => !allowed \|\| allowed\.has\(segment\.id\)\)/)
assert.match(
  wordRangeNormalizerSource,
  /sourceText: formatWordRangeSourceSegments\(input\.content, supplementalSegmentIds\)/
)
assert.doesNotMatch(wordRangeNormalizerSource, /【已保留候选，不得重复引用这些片段】/)
assert.match(wordRangeNormalizerSource, /usedSegmentIds\.has\(patch\.segmentId\)/)
assert.match(wordRangeNormalizerSource, /insertAfter 只能包含新增文本，严禁复制原片段或重写整章/)
assert.match(causalOutcomePipelineSource, /actorMutationSchema/)
assert.match(causalOutcomePipelineSource, /schema: input\.schema/)
assert.match(causalOutcomePipelineSource, /variant\(\['knowledge'\], \['add'\]\)/)
assert.match(
  causalOutcomePipelineSource,
  /variant\(\['resources', 'relationships', 'obligations'\], \['add', 'remove'\]\)/
)
const activeOutcomePipelineSource = causalOutcomePipelineSource.slice(
  causalOutcomePipelineSource.indexOf('export async function runCausalOutcomePipeline')
)
assert.doesNotMatch(activeOutcomePipelineSource, /ensureProofCarryingOutcomeBundle\(common\)/)
assert.doesNotMatch(activeOutcomePipelineSource, /requestProofCarryingStateDelta\(common\)/)
assert.match(causalOutcomePipelineSource, /const NORMAL_STAGE_MODEL_CALLS = 4/)
assert.match(causalOutcomePipelineSource, /const STAGE_EXTRACTION_ATTEMPTS = 2/)
assert.match(causalOutcomePipelineSource, /const STAGE_REPAIR_ATTEMPTS = 2/)
assert.match(
  causalOutcomePipelineSource,
  /const MAX_STAGE_MODEL_CALLS = NORMAL_STAGE_MODEL_CALLS \* STAGE_EXTRACTION_ATTEMPTS/
)
assert.match(causalOutcomePipelineSource, /reservePipelineCalls/)
assert.match(causalOutcomePipelineSource, /`\$\{input\.stage\}:atomization`/)
assert.match(causalOutcomePipelineSource, /同一数组内每个压力 ID 最多出现一次/)
assert.match(causalOutcomePipelineSource, /ACTOR_STAGE_MIN_OUTPUT_TOKENS = 4800/)
assert.match(causalOutcomePipelineSource, /ACTOR_STAGE_MAX_OUTPUT_TOKENS = 7200/)
assert.match(causalOutcomePipelineSource, /input\.lastError\.includes\('OUTPUT_TRUNCATED'\)/)
const causalOutcomeContextSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/causal-outcome-context.ts'),
  'utf8'
)
assert.match(causalOutcomeContextSource, /knowledgeLedgerCount: actor\.knowledge\.length/)
assert.match(causalOutcomeContextSource, /resourceLedgerCount: actor\.resources\.length/)
assert.match(causalOutcomeContextSource, /relationshipLedgerCount: actor\.relationships\.length/)
assert.match(causalOutcomeContextSource, /obligationLedgerCount: actor\.obligations\.length/)
assert.doesNotMatch(causalOutcomeContextSource, /resources: actor\.resources/)
assert.doesNotMatch(causalOutcomeContextSource, /relationships: actor\.relationships/)
assert.doesNotMatch(causalOutcomeContextSource, /obligations: actor\.obligations/)
assert.match(causalOutcomePipelineSource, /resources 只记录章末相对章初的净增减/)
assert.match(causalOutcomePipelineSource, /repairStageEvidenceIds/)
assert.match(causalOutcomePipelineSource, /声明文本已经冻结，只能为列出的错误路径重新选择正文证据 ID/)
assert.match(causalOutcomePipelineSource, /step: `goal_novel_causal_outcome_\$\{input\.stage\}`/)
assert.match(causalOutcomePipelineSource, /pattern: '\^e\\\\d\{4\}\$'/)
assert.doesNotMatch(causalOutcomePipelineSource, /items: \{ type: 'string', enum: ids \}/)
assert.doesNotMatch(causalOutcomePipelineSource, /claimId: \{ type: 'string', enum:/)
assert.doesNotMatch(causalOutcomePipelineSource, /path: \{ type: 'string', enum: paths \}/)
assert.doesNotMatch(causalOutcomePipelineSource, /minItems: .*\.length|maximum: .*\.length/)
assert.doesNotMatch(
  activeOutcomePipelineSource,
  /await auditAtomicClaims\(/,
  '章节携证事务必须本地验证 evidence ID，禁止再次逐声明调用模型审计'
)
const causalBodyRepairSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/causal-body-contract-repair.ts'),
  'utf8'
)
assert.match(causalBodyRepairSource, /repairNovelChapterByEvidencePatches/)
assert.doesNotMatch(causalBodyRepairSource, /repairNovelExecutionCandidate/)
assert.match(evidenceRepairSource, /structuredOutputMode: 'prompt_json'/)
assert.match(evidenceRepairSource, /causal_body_contract/)
assert.equal(stepAcceptsWorkBodySlotModel('body_generation_scene'), false)
const storyGoalDoerSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-goal-doer.ts'),
  'utf8'
)
assert.doesNotMatch(storyGoalDoerSource, /enum: sentences|maxItems: sentences\.length/)
assert.doesNotMatch(storyGoalDoerSource, /removeBodyReactionClichesDeterministically/)
assert.match(storyGoalDoerSource, /label: `泛白类身体反应定点修复第\$\{round\}轮`/)
const activeBodyGenerationSource = storyGoalDoerSource.slice(
  storyGoalDoerSource.indexOf('export async function generateBeatBody'),
  storyGoalDoerSource.indexOf('async function repairStoryContinuityCandidate')
)
assert.match(
  activeBodyGenerationSource,
  /persistChapterExecutionContract\(workId, chapterId, wordTargetOverride, wordCountToleranceOverride\)/,
  '长篇正文必须以章节执行合同的目标字数作为提示与验收的共同权威'
)
assert.match(activeBodyGenerationSource, /const wordTarget = executionContract\?\.wordTarget \?\? requestedWordTarget/)
assert.doesNotMatch(activeBodyGenerationSource, /body_generation_scene/)
assert.doesNotMatch(activeBodyGenerationSource, /novel_scene_partial|novel_scene_complete/)
assert.equal(
  (activeBodyGenerationSource.match(/await modelService\.chat\(/g) ?? []).length,
  1,
  '正文生成边界只能发起一次完整正文请求'
)
const novelPersistenceSource = storyGoalDoerSource.slice(
  storyGoalDoerSource.indexOf('async function persistGeneratedBody'),
  storyGoalDoerSource.indexOf("if (workType === 'story') {\n    const chapters", storyGoalDoerSource.indexOf('async function persistGeneratedBody'))
)
assert.doesNotMatch(novelPersistenceSource, /assessNovelExecutionCandidate|repairNovelExecutionCandidate|convergeNovelExecutionWordRange/)
assert.match(novelPersistenceSource, /workType === 'story'[\s\S]*?repairBodyReactionCliches/)
const storyContractSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-contract.ts'),
  'utf8'
)
assert.match(storyContractSource, /requestStructuredModelOutput<StoryContract>/)
assert.match(storyContractSource, /requestQualityEvaluatorEvidence<string\[]>/)
assert.doesNotMatch(storyContractSource, /const response = await modelService\.chat/)
assert.doesNotMatch(storyContractSource, /forbidden_final_threads: strings\([^\n]+\)\.length/)
const storyEngineGateSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-engine-gate.ts'),
  'utf8'
)
assert.match(storyEngineGateSource, /requestStructuredModelOutput<EngineGatePayload>/)
assert.doesNotMatch(storyEngineGateSource, /for \(let attempt = 1; attempt <= STORY_ENGINE_FORMAT_ATTEMPTS/)
const storyEngineAuditSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-engine-semantic-audit.ts'),
  'utf8'
)
assert.match(storyEngineAuditSource, /requestQualityEvaluatorEvidence<StoryHarnessIssue\[]>/)
assert.doesNotMatch(storyEngineAuditSource, /const response = await modelService\.chat/)
const storyContinuityGateSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-continuity-gate.ts'),
  'utf8'
)
assert.match(storyContinuityGateSource, /evaluatorFailureCode\?: 'QUALITY_EVALUATOR_UNAVAILABLE'/)
assert.match(storyContinuityGateSource, /requestQualityEvaluatorEvidence<StoryContinuityGateResult>/)
assert.doesNotMatch(storyContinuityGateSource, /跨拍连续性门禁返回格式无效/)
assert.doesNotMatch(storyGoalDoerSource, /let evaluatorRetries = 0/)
const storyGoalBeatsSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-goal-beats.ts'),
  'utf8'
)
assert.match(storyGoalBeatsSource, /requestStructuredModelOutput<ParsedChapter\[]>/)
assert.match(storyGoalBeatsSource, /requestQualityEvaluatorEvidence<BeatGateResult>/)
assert.doesNotMatch(storyGoalBeatsSource, /function extractFirstJsonObject/)
const storyGoalSetupSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-goal-setup.ts'),
  'utf8'
)
assert.match(storyGoalSetupSource, /requestStructuredModelOutput<SlotCandidate\[]>/)
assert.match(storyGoalSetupSource, /requestQualityEvaluatorEvidence</)
assert.doesNotMatch(storyGoalSetupSource, /return \{ \.\.\.fallback/)
assert.doesNotMatch(storyGoalSetupSource, /parseCharacterCardsFromAi/)
const storyGoalRoutineSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-goal-routine.ts'),
  'utf8'
)
assert.match(storyGoalRoutineSource, /STORY_REPAIR_PROTOCOL_VERSION = 7/)
assert.match(storyGoalRoutineSource, /label: '短故事书名导语候选'/)
assert.match(storyGoalRoutineSource, /label: '短故事导语防剧透门禁'/)
assert.match(storyGoalRoutineSource, /label: '短故事核心设定整体自检'/)
const storyPairwiseSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-pairwise-evaluator.ts'),
  'utf8'
)
assert.match(storyPairwiseSource, /requestQualityEvaluatorEvidence/)
assert.doesNotMatch(storyPairwiseSource, /if \(!res\.success[^\n]+return left/)
assert.doesNotMatch(storyPairwiseSource, /if \(!res\.success[^\n]+return 'tie'/)
const storyGoalRepairSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/story-goal-repair.ts'),
  'utf8'
)
assert.match(storyGoalRepairSource, /label: '短故事结构层节拍修复'/)
assert.match(storyGoalRepairSource, /label: '短故事导语定向修复'/)
assert.match(storyGoalRepairSource, /label: '短故事导语独立复验'/)
const emotionGateSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/emotion-gate.ts'),
  'utf8'
)
const emotionLedgerBatchSource = emotionGateSource.slice(
  emotionGateSource.indexOf('async function extractEmotionLedgerBatch'),
  emotionGateSource.indexOf('async function extractEmotionalLedgerRows')
)
assert.match(emotionLedgerBatchSource, /requestStructuredModelOutput/)
assert.doesNotMatch(emotionLedgerBatchSource, /for \(let attempt/)
const novelPackagingSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/novel-packaging.ts'),
  'utf8'
)
assert.match(novelPackagingSource, /requestStructuredModelOutput/)
assert.doesNotMatch(novelPackagingSource, /extractJsonText|parseCharacterCardsFromAi|JSON\.parse/)
for (const modulePath of [
  'src/main/context/goal-routine/novel-volume-planning.ts',
  'src/main/context/goal-routine/novel-volume-chapter-gate.ts',
  'src/main/context/goal-routine/novel-outline-pipeline.ts'
]) {
  const lines = fs.readFileSync(path.resolve(modulePath), 'utf8').split('\n').length
  assert.ok(lines <= 2000, `${modulePath} 必须按功能拆分到 2000 行以内，实际 ${lines} 行`)
}
const novelWholeEvaluatorSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/novel-whole-evaluator.ts'),
  'utf8'
)
assert.match(novelWholeEvaluatorSource, /const NOVEL_WHOLE_ASSESSMENT_SCHEMA/)
assert.match(novelWholeEvaluatorSource, /label: '小说整书终审',[\s\S]*?attempts: 2/)
assert.match(novelWholeEvaluatorSource, /schema: NOVEL_WHOLE_ASSESSMENT_SCHEMA/)
const modelServiceSource = fs.readFileSync(path.resolve('src/main/model/model-service.ts'), 'utf8')
assert.match(modelServiceSource, /isFullProseOutputStep\(request\.step\)/)
assert.match(modelServiceSource, /proseOutputThinkingDisabled[\s\S]*?thinkingEnabled = false/)
const executionGateSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/novel-execution-gate.ts'),
  'utf8'
)
const executionWireSchemaSource = executionGateSource.slice(
  executionGateSource.indexOf('function responseSchema'),
  executionGateSource.indexOf('export function novelExecutionGateMaxTokens')
)
assert.doesNotMatch(
  executionWireSchemaSource,
  /evidence_ids:\s*\{[\s\S]{0,180}?maxItems/,
  '模型传输 Schema 不得用证据数量上限阻止业务规范化'
)
const causalOutcomeEvidenceWireSchema = causalOutcomePipelineSource.slice(
  causalOutcomePipelineSource.indexOf('function evidenceArraySchema'),
  causalOutcomePipelineSource.indexOf('function runtimeReferenceSchema')
)
assert.doesNotMatch(
  causalOutcomeEvidenceWireSchema,
  /maxItems\s*[:,]/,
  '因果结果传输 Schema 不得在原子化修复之前截断证据 ID 数量'
)
assert.match(
  causalOutcomePipelineSource,
  /repairStageAtomization[\s\S]*?OUTCOME_ATOMIZATION_REQUIRED/,
  '超出原子证据上限必须交给业务层定向拆分'
)
assert.doesNotMatch(
  executionWireSchemaSource,
  /requirement_id:\s*\{[^}]*enum/,
  '章节取证传输 Schema 不得直接绑定动态验收项 ID'
)
const hardGateSource = executionGateSource.slice(
  executionGateSource.indexOf('export async function assessNovelExecutionCandidate'),
  executionGateSource.indexOf('export async function repairNovelExecutionCandidate')
)
assert.match(hardGateSource, /for \(let attempt = 1; attempt <= 2; attempt\+\+\)/)
assert.match(hardGateSource, /章节硬合同连续 2 次只读取证仍未形成完整 coverage\/safety/)
assert.doesNotMatch(
  hardGateSource,
  /整批响应一旦截断|novel_execution_gate_coverage|novel_execution_gate_safety/,
  '章节硬合同协议修复只能重取完整只读证据，源码中不得保留拆批模型路径'
)
const unifiedChapterSource = fs.readFileSync(
  path.resolve('src/main/context/goal-routine/unified-novel-chapter.ts'),
  'utf8'
)
assert.doesNotMatch(unifiedChapterSource, /prepareNarrativeMemoryAfterGeneration/)
assert.match(
  unifiedChapterSource,
  /await prepareUnifiedNovelCausalOutcome[\s\S]*?await prepareUnifiedNovelNarrativeMemory/,
  '小说叙事记忆必须从携证因果结果投影，禁止再调用独立记忆提取模型'
)
const repairExecutionCheckpointSource = repairExecutionSource.slice(
  repairExecutionSource.indexOf('export async function runVolumeBodyCheckpoint'),
  repairExecutionSource.indexOf('export async function executeNovelRepairPlan')
)
assert.doesNotMatch(repairExecutionCheckpointSource, /assessNovelVolume/)
assert.doesNotMatch(repairExecutionCheckpointSource, /executeNovelRepairPlan/)

const contextRoot = path.resolve('src/main/context')
const files: string[] = []
function collect(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(absolute)
    else if (entry.isFile() && absolute.endsWith('.ts')) files.push(absolute)
  }
}
collect(contextRoot)

const missingModes: string[] = []
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set(node.properties.map(property => property.name?.getText(ast)))
      if (keys.has('responseSchema') && !keys.has('structuredOutputMode')) {
        missingModes.push(`${path.relative(process.cwd(), file)}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}
assert.deepEqual(
  missingModes,
  [],
  `结构化模型请求必须显式声明传输协议：${missingModes.join(', ')}`
)

console.log('novel goal architecture tests passed')
