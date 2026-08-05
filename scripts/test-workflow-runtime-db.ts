import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { closeDatabase, injectDatabaseForTest } from '../src/main/db/connection'
import { initSchema } from '../src/main/db/schema'
import {
  appPreferenceDAO,
  goalRoutineDAO,
  modelCallAttemptDAO,
  modelConfigDAO,
  novelChapterGateDAO,
  novelChapterAcceptanceDAO,
  novelAuthorityStateDAO,
  novelReleaseWindowDAO,
  workflowModelContractDAO
} from '../src/main/db'
import { GoalRoutineDAO } from '../src/main/db/dao/goal-routine-dao'
import {
  ensureWorkflowModelContract,
  resolveWorkflowModelSelection
} from '../src/main/workflow/workflow-model-contract'
import {
  ensureNovelAuthorityState,
  readNovelPersistentState,
  updateNovelPersistentState
} from '../src/main/context/goal-routine/novel-authority-state'
import { novelChapterContentHash } from '../src/main/context/goal-routine/novel-chapter-acceptance-policy'
import {
  blockNovelChapterAcceptance,
  getNovelChapterAcceptanceSummary
} from '../src/main/context/goal-routine/novel-chapter-acceptance-ledger'
import {
  buildAutonomousChapterRepairPlan,
  buildExecutionContractStructuralReplan,
  clearAutonomousChapterEscalation,
  reconcileAutonomousRepairGate,
  recoverInterruptedExecutionContractRepairOnResume
} from '../src/main/context/goal-routine/novel-autonomous-control'
import {
  NOVEL_WORKFLOW_DEFINITION_VERSION,
  reconcileNovelWorkflowDefinition
} from '../src/main/context/goal-routine/novel-workflow-definition'
import {
  readChapterTransactionBudget,
  reserveChapterTransactionPatch
} from '../src/main/context/goal-routine/novel-chapter-transaction-policy'

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
injectDatabaseForTest(db)
initSchema()

try {
  const workId = Number(db.prepare(
    "INSERT INTO works (title, work_type) VALUES ('工作流故障注入', 'story')"
  ).run().lastInsertRowid)

  const acceptanceWorkId = Number(db.prepare(
    "INSERT INTO works (title, work_type) VALUES ('章节验收账本', 'novel')"
  ).run().lastInsertRowid)
  const volumeId = Number(db.prepare(
    "INSERT INTO volumes (work_id, name, sort) VALUES (?, '第一卷', 1)"
  ).run(acceptanceWorkId).lastInsertRowid)
  const chapterId = Number(db.prepare(
    "INSERT INTO chapters (volume_id, title, content, word_count, sort) VALUES (?, '第一章', '初始正文', 4, 1)"
  ).run(volumeId).lastInsertRowid)
  const chapterId2 = Number(db.prepare(
    "INSERT INTO chapters (volume_id, title, content, word_count, sort) VALUES (?, '第二章', '第二章正文', 5, 2)"
  ).run(volumeId).lastInsertRowid)
  const chapterId3 = Number(db.prepare(
    "INSERT INTO chapters (volume_id, title, content, word_count, sort) VALUES (?, '第三章', '第三章正文', 5, 3)"
  ).run(volumeId).lastInsertRowid)
  const blockedReleaseAuditId = novelReleaseWindowDAO.start({
    workId: acceptanceWorkId,
    startChapterId: chapterId,
    endChapterId: chapterId3,
    startIndex: 1,
    endIndex: 8,
    sourceHash: 'blocked-source-hash',
    authorityRevision: 3,
    protocolVersion: 1
  })
  assert.equal(novelReleaseWindowDAO.finish({
    auditId: blockedReleaseAuditId,
    status: 'blocked',
    overallScore: 70,
    scores: { continuity: 60 },
    blockers: ['连续性不足'],
    summary: '不可发布',
    issues: [{
      code: 'CONTINUITY_BREAK',
      severity: 'blocker',
      chapterIds: [chapterId, chapterId3],
      evidence: ['前后事实冲突'],
      message: '事实状态冲突',
      requiredFix: '按证据簇修复'
    }]
  }), null)
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM novel_release_window_snapshots').get().count,
    0,
    '未通过审读不得生成发布快照'
  )
  const passedReleaseAuditId = novelReleaseWindowDAO.start({
    workId: acceptanceWorkId,
    startChapterId: chapterId,
    endChapterId: chapterId3,
    startIndex: 1,
    endIndex: 8,
    sourceHash: 'passed-source-hash',
    authorityRevision: 4,
    protocolVersion: 1
  })
  const releaseSnapshotId = novelReleaseWindowDAO.finish({
    auditId: passedReleaseAuditId,
    status: 'passed',
    overallScore: 82,
    scores: { continuity: 90, overall: 82 },
    blockers: [],
    summary: '达到首发线',
    issues: []
  })
  assert.ok(releaseSnapshotId)
  assert.equal(
    novelReleaseWindowDAO.findPassed(acceptanceWorkId, 1, 8, 'passed-source-hash')?.id,
    passedReleaseAuditId
  )
  assert.equal(
    novelReleaseWindowDAO.findPassed(acceptanceWorkId, 1, 8, 'changed-source-hash'),
    undefined,
    '正文哈希变化后旧快照不得放行'
  )
  const releaseProof = JSON.parse(String(db.prepare(
    'SELECT proof_json FROM novel_release_window_snapshots WHERE id = ?'
  ).get(releaseSnapshotId).proof_json))
  assert.equal(releaseProof.authorityRevision, 4)
  assert.equal(releaseProof.sourceHash, 'passed-source-hash')
  goalRoutineDAO.beginRun({
    workId: acceptanceWorkId,
    workflowType: 'novel',
    resume: false,
    maxTurns: 60,
    currentPhase: 'draft_body',
    goalConfigJson: '{"maxTurns":60,"autonomousMaxEpochs":20}'
  })
  const escalation1 = buildAutonomousChapterRepairPlan({
    workId: acceptanceWorkId,
    chapterId: chapterId2,
    gateType: 'emotion',
    failedMetrics: ['情绪门禁 79分/scene层']
  })
  assert.deepEqual(escalation1.plan.targetChapterIds, [chapterId2])
  assert.equal(escalation1.plan.scope, 'chapter')
  assert.equal(escalation1.plan.action, 'emotion')
  assert.equal(
    readChapterTransactionBudget({
      workId: acceptanceWorkId,
      chapterId: chapterId2,
      lane: 'semantic_repair'
    }),
    undefined,
    '生成修复计划不得消耗正文补丁事务'
  )
  reserveChapterTransactionPatch({
    workId: acceptanceWorkId,
    chapterId: chapterId2,
    failureKind: 'emotion',
    lane: 'semantic_repair'
  })
  const wordRangeEscalation = buildAutonomousChapterRepairPlan({
    workId: acceptanceWorkId,
    chapterId: chapterId3,
    gateType: 'execution_contract',
    failureCode: 'BODY_WORD_RANGE_NON_CONVERGENT',
    wordRange: { actual: 2785, min: 1500, target: 2000, max: 2500, direction: 'compress' },
    failedMetrics: ['章节字数 2785 不在合同范围 1500-2500']
  })
  assert.equal(wordRangeEscalation.plan.action, 'normalize_length')
  assert.deepEqual(wordRangeEscalation.plan.wordRange, {
    actual: 2785, min: 1500, target: 2000, max: 2500, direction: 'compress'
  })
  updateNovelPersistentState(acceptanceWorkId, {
    repairPlan: {
      action: 'execution_contract',
      scope: 'chapter',
      targetChapterIds: [chapterId3],
      hint: '恢复前门禁证据'
    }
  })
  reconcileAutonomousRepairGate(
    acceptanceWorkId,
    chapterId3,
    'execution_contract',
    ['恢复时只重建门禁证据，不执行正文补丁']
  )
  assert.equal(
    readChapterTransactionBudget({
      workId: acceptanceWorkId,
      chapterId: chapterId3,
      lane: 'semantic_repair'
    }),
    undefined,
    '断点证据协调是只读状态重建，不得提前消耗语义补丁事务'
  )
  buildAutonomousChapterRepairPlan({
    workId: acceptanceWorkId,
    chapterId: chapterId3,
    gateType: 'execution_contract',
    failedMetrics: ['门禁重新执行后仍然失败']
  })
  assert.equal(
    readChapterTransactionBudget({
      workId: acceptanceWorkId,
      chapterId: chapterId3,
      lane: 'semantic_repair'
    }),
    undefined,
    '重复生成修复计划仍不得消耗语义补丁事务'
  )
  reserveChapterTransactionPatch({
    workId: acceptanceWorkId,
    chapterId: chapterId3,
    failureKind: 'execution_contract',
    lane: 'semantic_repair'
  })
  const structuralReplan = buildExecutionContractStructuralReplan({
    workId: acceptanceWorkId,
    chapterId: chapterId3,
    failedMetrics: ['章节合同：提前越界：敌对回收者正面露脸进楼']
  })
  assert.equal(structuralReplan.action, 'cluster')
  assert.equal(structuralReplan.scope, 'cluster')
  assert.match(structuralReplan.hint, /禁止再次修订正文/)
  updateNovelPersistentState(acceptanceWorkId, {
    repairPlan: {
      action: 'execution_contract',
      scope: 'chapter',
      targetChapterIds: [chapterId2],
      hint: '旧的正文定点补丁计划',
      issueCodes: ['章节合同：提前越界']
    }
  })
  const resumedStructuralReplan = recoverInterruptedExecutionContractRepairOnResume(acceptanceWorkId)
  assert.equal(resumedStructuralReplan?.action, 'cluster')
  assert.equal(resumedStructuralReplan?.targetChapterIds[0], chapterId2)
  assert.throws(
    () => reserveChapterTransactionPatch({
      workId: acceptanceWorkId,
      chapterId: chapterId2,
      failureKind: 'emotion',
      lane: 'semantic_repair'
    }),
    /语义修复.*唯一一次补丁/
  )
  reserveChapterTransactionPatch({
    workId: acceptanceWorkId,
    chapterId: chapterId2,
    failureKind: 'BODY_WORD_RANGE_NON_CONVERGENT',
    lane: 'length_normalization'
  })
  reserveChapterTransactionPatch({
    workId: acceptanceWorkId,
    chapterId: chapterId2,
    failureKind: 'REPEATED_HOOK',
    lane: 'structural_replan'
  })
  clearAutonomousChapterEscalation(acceptanceWorkId, chapterId2)
  assert.equal(
    readChapterTransactionBudget({
      workId: acceptanceWorkId,
      chapterId: chapterId2,
      lane: 'semantic_repair'
    })?.patchesUsed,
    1,
    '清理升级记录不得重置当前运行的章节事务预算'
  )
  assert.equal(
    readChapterTransactionBudget({
      workId: acceptanceWorkId,
      chapterId: chapterId2,
      lane: 'length_normalization'
    })?.patchesUsed,
    1,
    '字数归一化与语义修复必须拥有互不挤占的事务预算'
  )
  assert.equal(
    readChapterTransactionBudget({
      workId: acceptanceWorkId,
      chapterId: chapterId2,
      lane: 'structural_replan'
    })?.patchesUsed,
    1,
    '结构重规划不得挤占正文语义修复或字数归一化预算'
  )
  const semanticBudgetBeforeReplan = readChapterTransactionBudget({
    workId: acceptanceWorkId,
    chapterId: chapterId2,
    lane: 'semantic_repair'
  })!
  db.prepare('UPDATE chapters SET outline = ? WHERE id = ?')
    .run('第二章结构重规划后的冻结大纲', chapterId2)
  const semanticBudgetAfterReplan = reserveChapterTransactionPatch({
    workId: acceptanceWorkId,
    chapterId: chapterId2,
    failureKind: 'EXECUTION_CONTRACT_REPLANNED',
    lane: 'semantic_repair'
  })
  assert.notEqual(
    semanticBudgetAfterReplan.contractHash,
    semanticBudgetBeforeReplan.contractHash,
    '结构重规划必须形成新的冻结合同身份'
  )
  assert.equal(
    semanticBudgetAfterReplan.patchesUsed,
    1,
    '新冻结合同拥有自己的唯一一次语义补丁，不能继承旧合同的已用次数'
  )
  assert.throws(
    () => reserveChapterTransactionPatch({
      workId: acceptanceWorkId,
      chapterId: chapterId2,
      failureKind: 'EXECUTION_CONTRACT_REPLANNED_AGAIN',
      lane: 'semantic_repair'
    }),
    /语义修复.*唯一一次补丁/,
    '同一新合同仍只能执行一次语义补丁'
  )
  assert.equal(
    JSON.parse(novelAuthorityStateDAO.get(acceptanceWorkId)!.state_json).chapterTransactionBudgets,
    undefined,
    '章节事务预算不得进入作品权威状态'
  )
  const authorityBeforeUpgrade = novelAuthorityStateDAO.get(acceptanceWorkId)!
  novelAuthorityStateDAO.update(
    acceptanceWorkId,
    authorityBeforeUpgrade.revision,
    JSON.stringify({
      ...JSON.parse(authorityBeforeUpgrade.state_json),
      chapterTransactionBudgets: { legacy: { patchesUsed: 1 } }
    })
  )
  updateNovelPersistentState(acceptanceWorkId, {
    workflowDefinitionVersion: 3,
    repairPlan: wordRangeEscalation.plan
  })
  goalRoutineDAO.update(acceptanceWorkId, { status: 'error', current_phase: 'repair_execute' })
  const workflowUpgrade = reconcileNovelWorkflowDefinition({
    workId: acceptanceWorkId,
    resume: true,
    phase: 'repair_execute',
    savedVersion: 3,
    turn: 9
  })
  assert.equal(workflowUpgrade.phase, 'draft_body')
  assert.equal(readNovelPersistentState(acceptanceWorkId).workflowDefinitionVersion, NOVEL_WORKFLOW_DEFINITION_VERSION)
  assert.equal(readNovelPersistentState(acceptanceWorkId).repairPlan, undefined)
  assert.deepEqual(readNovelPersistentState(acceptanceWorkId).chapterTransactionBudgets, {})
  assert.equal(
    JSON.parse(novelAuthorityStateDAO.get(acceptanceWorkId)!.state_json).chapterTransactionBudgets,
    undefined,
    'v5 迁移必须物理清除历史误写入权威状态的事务预算'
  )
  const bestContent = '第二章正文'
  const degradedContent = '第二章退化候选'
  const gateOwnershipEpisode = novelChapterAcceptanceDAO.createEpisode({
    episodeKey: 'gate-ownership',
    workId: acceptanceWorkId,
    chapterId: chapterId2,
    baseContentHash: novelChapterContentHash(bestContent),
    contractHash: 'contract-gate-ownership',
    protocolVersion: 2,
    maxAssessments: 4,
    maxRepairs: 7
  })
  const bestGateCandidate = novelChapterAcceptanceDAO.addCandidate({
    episodeId: gateOwnershipEpisode.id,
    contentHash: novelChapterContentHash(bestContent),
    sourceKind: 'baseline',
    content: bestContent,
    wordCount: 5
  })
  const degradedGateCandidate = novelChapterAcceptanceDAO.addCandidate({
    episodeId: gateOwnershipEpisode.id,
    contentHash: novelChapterContentHash(degradedContent),
    sourceKind: 'emotion_repair',
    parentContentHash: novelChapterContentHash(bestContent),
    content: degradedContent,
    wordCount: 7
  })
  novelChapterAcceptanceDAO.addAssessment({
    episodeId: gateOwnershipEpisode.id,
    candidateId: bestGateCandidate.id,
    scoreTotal: 82,
    hardFail: false,
    passed: true,
    blockingFailures: [],
    advisoryFailures: [],
    topIssues: [],
    patches: [],
    report: '{"score_total":82}'
  })
  novelChapterAcceptanceDAO.addAssessment({
    episodeId: gateOwnershipEpisode.id,
    candidateId: degradedGateCandidate.id,
    scoreTotal: 58,
    hardFail: true,
    passed: false,
    blockingFailures: ['内容逻辑 60/65'],
    advisoryFailures: [],
    topIssues: [],
    patches: [],
    report: '{"score_total":58}'
  })
  novelChapterAcceptanceDAO.setBestCandidate(gateOwnershipEpisode.id, bestGateCandidate.id)
  novelChapterGateDAO.ensureStates(gateOwnershipEpisode.id, bestGateCandidate.id)
  novelChapterGateDAO.setState({
    episodeId: gateOwnershipEpisode.id,
    candidateId: bestGateCandidate.id,
    gateType: 'quality',
    status: 'passed_model',
    score: 82,
    blockers: []
  })
  novelChapterGateDAO.setState({
    episodeId: gateOwnershipEpisode.id,
    candidateId: bestGateCandidate.id,
    gateType: 'emotion',
    status: 'failed',
    score: 79,
    failureCode: 'EMOTION_GATE_FAILED',
    failureReason: '情绪门禁 79分/scene层',
    blockers: ['情绪落差不足']
  })
  db.prepare('UPDATE chapters SET content = ? WHERE id = ?')
    .run(degradedContent, chapterId2)
  blockNovelChapterAcceptance(
    gateOwnershipEpisode.id,
    'EVIDENCE_PATCH_UNAVAILABLE',
    '失败候选没有可执行补丁',
    'quality',
    ['内容逻辑 60/65']
  )
  assert.equal(
    novelChapterGateDAO.getState(
      gateOwnershipEpisode.id,
      bestGateCandidate.id,
      'quality'
    )?.status,
    'passed_model',
    '失败候选的质量失败不得污染恢复后的最佳正文'
  )
  assert.equal(getNovelChapterAcceptanceSummary(acceptanceWorkId)?.blockedGate, 'emotion')
  assert.equal(
    db.prepare('SELECT content FROM chapters WHERE id = ?').get(chapterId2).content,
    bestContent
  )
  goalRoutineDAO.setStatus(acceptanceWorkId, 'goal_met')
  const baselineHash = novelChapterContentHash('初始正文')
  const repairedHash = novelChapterContentHash('修订正文')
  const acceptanceEpisode = novelChapterAcceptanceDAO.createEpisode({
    episodeKey: 'episode-1',
    workId: acceptanceWorkId,
    chapterId,
    baseContentHash: baselineHash,
    contractHash: 'contract-a',
    protocolVersion: 2,
    maxAssessments: 4,
    maxRepairs: 7
  })
  const baselineCandidate = novelChapterAcceptanceDAO.addCandidate({
    episodeId: acceptanceEpisode.id,
    contentHash: baselineHash,
    sourceKind: 'baseline',
    content: '初始正文',
    wordCount: 4
  })
  novelChapterGateDAO.ensureStates(acceptanceEpisode.id, baselineCandidate.id)
  novelChapterAcceptanceDAO.addAssessment({
    episodeId: acceptanceEpisode.id,
    candidateId: baselineCandidate.id,
    scoreTotal: 70,
    hardFail: true,
    passed: false,
    blockingFailures: ['内容逻辑 60/65'],
    advisoryFailures: [],
    topIssues: [{ id: 'logic', evidence: '初始正文', fixHint: '补足因果' }],
    patches: [{ find: '初始正文', replace: '修订正文' }],
    report: '{"score_total":70}'
  })
  novelChapterAcceptanceDAO.setBestCandidate(acceptanceEpisode.id, baselineCandidate.id)
  const repairCandidate = novelChapterAcceptanceDAO.reserveRepairCandidate({
    episodeId: acceptanceEpisode.id,
    contentHash: repairedHash,
    parentContentHash: baselineHash,
    sourceKind: 'quality_patch',
    gateType: 'quality',
    gateRepairLimit: 3,
    content: '修订正文',
    wordCount: 4
  })
  assert.equal(repairCandidate.parent_content_hash, baselineHash)
  assert.equal(novelChapterAcceptanceDAO.getEpisode(acceptanceEpisode.id)?.assessments_used, 1)
  assert.equal(novelChapterAcceptanceDAO.getEpisode(acceptanceEpisode.id)?.repairs_used, 1)
  assert.equal(
    novelChapterAcceptanceDAO.findEpisodeByCandidate({
      workId: acceptanceWorkId,
      chapterId,
      contentHash: repairedHash,
      contractHash: 'contract-a',
      protocolVersion: 2
    })?.id,
    acceptanceEpisode.id,
    '修订正文必须继续归属于同一验收事件'
  )
  novelChapterAcceptanceDAO.addAssessment({
    episodeId: acceptanceEpisode.id,
    candidateId: repairCandidate.id,
    scoreTotal: 71,
    hardFail: true,
    passed: false,
    blockingFailures: ['内容逻辑 60/65'],
    advisoryFailures: [],
    topIssues: [],
    patches: [],
    report: '{"score_total":71}'
  })
  novelChapterAcceptanceDAO.setBestCandidate(acceptanceEpisode.id, repairCandidate.id)
  db.prepare('UPDATE chapters SET content = ? WHERE id = ?').run('修订正文', chapterId)
  novelChapterGateDAO.setState({
    episodeId: acceptanceEpisode.id,
    candidateId: repairCandidate.id,
    gateType: 'quality',
    status: 'failed',
    score: 71,
    failureCode: 'PLATEAU',
    failureReason: '连续两次没有改善',
    blockers: ['内容逻辑 60/65']
  })
  novelChapterAcceptanceDAO.finish(acceptanceEpisode.id, {
    status: 'blocked',
    terminalCode: 'PLATEAU',
    terminalReason: '连续两次没有改善'
  })
  assert.throws(
    () => novelChapterAcceptanceDAO.addAssessment({
      episodeId: acceptanceEpisode.id,
      candidateId: repairCandidate.id,
      scoreTotal: 71,
      hardFail: true,
      passed: false,
      blockingFailures: ['内容逻辑 60/65'],
      advisoryFailures: [],
      topIssues: [],
      patches: [],
      report: '{"score_total":71}'
    }),
    /当前不可写入评估/,
    '非收敛终态不得通过断点续跑重置预算'
  )
  assert.throws(
    () => novelChapterAcceptanceDAO.reserveRepairCandidate({
      episodeId: acceptanceEpisode.id,
      contentHash: novelChapterContentHash('终态后的新正文'),
      parentContentHash: repairedHash,
      sourceKind: 'quality_patch',
      gateType: 'quality',
      gateRepairLimit: 3,
      content: '终态后的新正文',
      wordCount: 7
    }),
    /状态为 blocked，禁止追加修订候选/,
    '已关闭验收事件不得把新正文误报为修订预算耗尽'
  )
  novelChapterGateDAO.setState({
    episodeId: acceptanceEpisode.id,
    candidateId: repairCandidate.id,
    gateType: 'quality',
    status: 'passed_model',
    score: 71,
    blockers: []
  })
  novelChapterGateDAO.setState({
    episodeId: acceptanceEpisode.id,
    candidateId: repairCandidate.id,
    gateType: 'emotion',
    status: 'failed',
    failureCode: 'EMOTION_NON_CONVERGENT',
    failureReason: '情绪门禁未通过',
    blockers: ['情绪峰值不足']
  })
  novelChapterAcceptanceDAO.finish(acceptanceEpisode.id, {
    status: 'blocked',
    terminalCode: 'EMOTION_NON_CONVERGENT',
    terminalReason: '情绪门禁未通过'
  })
  assert.equal(
    novelChapterAcceptanceDAO.getEpisode(acceptanceEpisode.id)?.status,
    'blocked'
  )
  assert.equal(
    novelChapterGateDAO.getState(acceptanceEpisode.id, repairCandidate.id, 'quality')?.status,
    'passed_model',
    '下游门禁失败不得抹掉同候选已通过的质量结论'
  )

  const idle = goalRoutineDAO.ensure(workId)
  assert.equal(idle.status, 'idle')
  assert.equal(idle.desired_state, 'paused')
  assert.equal(idle.lease_owner, null, '只读/预创建状态不能占用执行租约')

  const run = goalRoutineDAO.beginRun({
    workId,
    workflowType: 'story',
    resume: false,
    maxTurns: 20,
    currentPhase: 'generate_beats',
    goalConfigJson: '{"maxTurns":20}'
  })
  assert.equal(run.status, 'running')
  assert.ok(run.lease_owner)

  modelConfigDAO.upsert(
    'frozen_provider',
    'test-key',
    'https://frozen.invalid/v1',
    'frozen-model'
  )
  appPreferenceDAO.setGlobalLlmDefault('frozen_provider', 'frozen-model')
  const frozen = ensureWorkflowModelContract(run.id, {
    modelType: 'frozen_provider',
    modelName: 'frozen-body-model',
    thinkingEnabled: false
  })
  assert.equal(frozen.created, true)
  assert.equal(workflowModelContractDAO.get(run.id)?.body.modelName, 'frozen-body-model')

  modelConfigDAO.upsert(
    'new_provider',
    'new-key',
    'https://new.invalid/v1',
    'new-model'
  )
  appPreferenceDAO.setGlobalLlmDefault('new_provider', 'new-model')
  assert.equal(
    resolveWorkflowModelSelection(run.id, 'goal_novel_causal_state')?.provider,
    'frozen_provider',
    '运行中修改全局模型不得改变已冻结执行合同'
  )

  const competingExecutor = new GoalRoutineDAO(db)
  assert.throws(
    () => competingExecutor.beginRun({
      workId,
      workflowType: 'story',
      resume: true,
      maxTurns: 20,
      currentPhase: 'generate_beats',
      goalConfigJson: '{"maxTurns":20}'
    }),
    /已被其他执行器持有/
  )

  const firstStep = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'generate_beats',
    scopeKey: 'work',
    input: { turn: 1, requirement: '建立不可变输入哈希' },
    protocolVersion: 3
  })
  assert.equal(firstStep.attempt_no, 1)

  modelCallAttemptDAO.start({
    requestId: 'runtime-test-request-1',
    runId: run.id,
    stepInstanceId: firstStep.id,
    workId,
    generationStep: firstStep.step_key,
    modelType: 'openai_compatible',
    modelName: 'test-model'
  })
  modelCallAttemptDAO.finish('runtime-test-request-1', {
    status: 'failed',
    errorClass: 'transient_transport',
    errorCode: 'ECONNRESET',
    errorMessage: '故障注入',
    durationMs: 12
  })
  modelCallAttemptDAO.start({
    requestId: 'runtime-test-request-interrupted',
    runId: run.id,
    stepInstanceId: firstStep.id,
    workId,
    generationStep: firstStep.step_key,
    modelType: 'openai_compatible',
    modelName: 'test-model'
  })

  const recoverable = goalRoutineDAO.markInterruptedForRecovery()
  assert.equal(recoverable.length, 1)
  assert.equal(recoverable[0].id, run.id)
  assert.equal(recoverable[0].status, 'waiting')
  assert.equal(recoverable[0].recovery_count, 1)
  assert.equal(
    (db.prepare('SELECT status FROM workflow_step_instances WHERE id = ?').get(firstStep.id) as { status: string }).status,
    'waiting'
  )

  const resumed = goalRoutineDAO.beginRun({
    workId,
    workflowType: 'story',
    resume: true,
    maxTurns: 20,
    currentPhase: 'generate_beats',
    goalConfigJson: '{"maxTurns":20}'
  })
  assert.equal(resumed.id, run.id, '进程恢复必须继续同一个持久化 Run')

  const secondStep = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'generate_beats',
    scopeKey: 'work',
    input: { requirement: '建立不可变输入哈希', turn: 1 },
    protocolVersion: 3
  })
  assert.equal(secondStep.input_hash, firstStep.input_hash, '对象键顺序不应改变输入身份')
  assert.equal(secondStep.attempt_no, 2)
  goalRoutineDAO.completeStep(secondStep.id, 'draft_body', { beatIds: [1, 2] })

  const thirdStep = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'generate_beats',
    scopeKey: 'work',
    input: { turn: 1, requirement: '建立不可变输入哈希' },
    protocolVersion: 3
  })
  goalRoutineDAO.completeStep(thirdStep.id, 'draft_body', { beatIds: [1, 2] })
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM workflow_artifacts').get() as { count: number }).count,
    1,
    '同一协议的相同输出工件必须幂等落库'
  )

  const repairDispositionStep = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'body_acceptance',
    scopeKey: 'chapter:99',
    input: { contentHash: 'word-range-invalid' },
    protocolVersion: 4
  })
  goalRoutineDAO.completeStep(
    repairDispositionStep.id,
    'repair_execute',
    undefined,
    'needs_repair'
  )
  assert.equal(
    (db.prepare('SELECT status FROM workflow_step_instances WHERE id = ?').get(repairDispositionStep.id) as { status: string }).status,
    'needs_repair'
  )

  const upgradedProtocolStep = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'generate_beats',
    scopeKey: 'work',
    input: { turn: 1, requirement: '建立不可变输入哈希' },
    protocolVersion: 4
  })
  assert.equal(
    upgradedProtocolStep.attempt_no,
    4,
    '协议升级不能重置受数据库唯一约束保护的步骤尝试序号'
  )
  goalRoutineDAO.completeStep(upgradedProtocolStep.id, 'draft_body', { beatIds: [1, 2] })

  assert.equal(goalRoutineDAO.listSteps(workId).length, 5)
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM workflow_artifacts').get() as { count: number }).count,
    2,
    '协议升级后的输出工件必须与旧协议隔离'
  )
  assert.equal(goalRoutineDAO.getStepAttemptCount(upgradedProtocolStep), 4)
  const diagnosedFirstStep = goalRoutineDAO.listSteps(workId)
    .find(step => step.id === firstStep.id)
  assert.equal(diagnosedFirstStep?.generation_step, 'generate_beats')
  assert.equal(diagnosedFirstStep?.model_name, 'test-model')

  const protocolInput = { stateProjection: 'bounded-v1' }
  const protocolStep1 = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'causal_state_init',
    phaseKey: 'draft_body',
    scopeKey: `work:${workId}`,
    input: protocolInput,
    protocolVersion: 4
  })
  goalRoutineDAO.failStep(protocolStep1.id, {
    errorClass: 'response_protocol',
    errorCode: 'RESPONSE_PROTOCOL',
    message: 'invalid json'
  })
  const rejectedArtifactId = goalRoutineDAO.recordStepArtifact(
    protocolStep1.id,
    'structured_response_rejected',
    {
      schemaName: 'causal_novel_candidate_drafts',
      error: '$.candidates[0].promiseAdvanced 不在允许枚举中',
      rawContent: '{"candidates":[{"promiseAdvanced":"promise_missing"}]}'
    }
  )
  assert.ok(rejectedArtifactId != null)
  assert.equal(
    (db.prepare(
      'SELECT output_artifact_id FROM workflow_step_instances WHERE id = ?'
    ).get(protocolStep1.id) as { output_artifact_id: number }).output_artifact_id,
    rejectedArtifactId,
    '失败结构化响应必须作为步骤制品持久化并与失败步骤关联'
  )
  const protocolStep2 = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'causal_state_init',
    phaseKey: 'draft_body',
    scopeKey: `work:${workId}`,
    input: protocolInput,
    protocolVersion: 4
  })
  goalRoutineDAO.failStep(protocolStep2.id, {
    errorClass: 'response_protocol',
    errorCode: 'RESPONSE_PROTOCOL',
    message: 'invalid json'
  })
  assert.equal(
    goalRoutineDAO.getConsecutiveStepFailureCount(
      protocolStep2,
      'response_protocol',
      'RESPONSE_PROTOCOL'
    ),
    2
  )
  const nextProtocolStep = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'causal_state_init',
    phaseKey: 'draft_body',
    scopeKey: `work:${workId}`,
    input: protocolInput,
    protocolVersion: 5
  })
  goalRoutineDAO.failStep(nextProtocolStep.id, {
    errorClass: 'response_protocol',
    errorCode: 'RESPONSE_PROTOCOL',
    message: 'new protocol invalid json'
  })
  assert.equal(goalRoutineDAO.getProtocolStepAttemptCount(nextProtocolStep), 1)
  assert.equal(
    goalRoutineDAO.getConsecutiveStepFailureCount(
      nextProtocolStep,
      'response_protocol',
      'RESPONSE_PROTOCOL'
    ),
    1,
    '新协议不得继承旧协议的结构化失败预算'
  )
  const transportStep = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'causal_state_init',
    phaseKey: 'draft_body',
    scopeKey: `work:${workId}`,
    input: protocolInput,
    protocolVersion: 4
  })
  goalRoutineDAO.failStep(transportStep.id, {
    errorClass: 'transient_transport',
    errorCode: 'TRANSIENT_TRANSPORT',
    message: 'timeout'
  })
  const protocolStep3 = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'causal_state_init',
    phaseKey: 'draft_body',
    scopeKey: `work:${workId}`,
    input: protocolInput,
    protocolVersion: 4
  })
  goalRoutineDAO.failStep(protocolStep3.id, {
    errorClass: 'response_protocol',
    errorCode: 'RESPONSE_PROTOCOL',
    message: 'invalid json'
  })
  assert.equal(
    goalRoutineDAO.getConsecutiveStepFailureCount(
      protocolStep3,
      'response_protocol',
      'RESPONSE_PROTOCOL'
    ),
    1,
    '不同错误类别必须拥有独立的连续失败序列'
  )
  const driftingProtocolStep = goalRoutineDAO.beginStep({
    workId,
    stepKey: 'causal_state_init',
    phaseKey: 'draft_body',
    scopeKey: `work:${workId}`,
    input: { stateProjection: 'bounded-v2' },
    protocolVersion: 4
  })
  goalRoutineDAO.failStep(driftingProtocolStep.id, {
    errorClass: 'response_protocol',
    errorCode: 'RESPONSE_PROTOCOL',
    message: 'invalid json'
  })
  assert.equal(
    goalRoutineDAO.getConsecutiveStepFailureCount(
      driftingProtocolStep,
      'response_protocol',
      'RESPONSE_PROTOCOL'
    ),
    1,
    '输入特定计数在输入漂移后从 1 开始'
  )
  assert.equal(
    goalRoutineDAO.getConsecutiveScopedStepFailureCount(
      driftingProtocolStep,
      'response_protocol',
      'RESPONSE_PROTOCOL'
    ),
    2,
    '作用域硬上限必须跨输入哈希识别连续同类失败'
  )
  assert.equal(
    goalRoutineDAO.getByWork(workId)?.current_phase,
    'draft_body',
    '持久化子步骤不得覆盖可恢复的状态机阶段'
  )

  goalRoutineDAO.appendTurn({
    work_id: workId,
    turn_no: 1,
    phase: 'generate_beats',
    action: 'step_recovered',
    summary: '故障后按同一输入重放并完成'
  })
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM workflow_outbox').get() as { count: number }).count,
    2
  )

  const attempt = db.prepare(
    'SELECT status, error_class, error_code FROM model_call_attempts WHERE request_id = ?'
  ).get('runtime-test-request-1') as {
    status: string
    error_class: string
    error_code: string
  }
  assert.deepEqual(attempt, {
    status: 'failed',
    error_class: 'transient_transport',
    error_code: 'ECONNRESET'
  })
  assert.deepEqual(
    db.prepare(
      'SELECT status, error_class, error_code FROM model_call_attempts WHERE request_id = ?'
    ).get('runtime-test-request-interrupted'),
    {
      status: 'failed',
      error_class: 'process_interrupted',
      error_code: 'PROCESS_INTERRUPTED'
    }
  )

  goalRoutineDAO.update(workId, { status: 'paused' })
  const replacement = goalRoutineDAO.beginRun({
    workId,
    workflowType: 'story',
    resume: false,
    maxTurns: 30,
    currentPhase: 'materialize_settings',
    goalConfigJson: '{"maxTurns":30}'
  })
  assert.equal(replacement.run_seq, 2)
  assert.equal(goalRoutineDAO.getById(run.id)?.status, 'superseded')
  goalRoutineDAO.setStatus(workId, 'cancelled')
  assert.equal(goalRoutineDAO.markInterruptedForRecovery().length, 0)
  assert.equal(
    (db.prepare(
      "SELECT COUNT(*) AS count FROM model_call_attempts WHERE status = 'running'"
    ).get() as { count: number }).count,
    0
  )

  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM goal_routine_states').get() as { count: number }).count,
    0,
    '新运行时禁止双写旧状态表'
  )
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM goal_routine_turns').get() as { count: number }).count,
    0,
    '新运行时禁止双写旧事件表'
  )

  const novelWorkId = Number(db.prepare(
    `INSERT INTO works (
       title, work_type, novel_length, target_total_words, target_chapters, words_per_chapter
     ) VALUES ('权威状态迁移', 'novel', 'long', 1600000, 800, 2000)`
  ).run().lastInsertRowid)
  const legacyRun = goalRoutineDAO.beginRun({
    workId: novelWorkId,
    workflowType: 'novel',
    resume: false,
    maxTurns: 60,
    currentPhase: 'draft_body',
    goalConfigJson: '{"maxTurns":60}'
  })
  goalRoutineDAO.update(novelWorkId, {
    status: 'paused',
    state_json: JSON.stringify({
      novelOutline: {
        version: 2,
        targetChapters: 800,
        volumePlan: [{
          name: '第一卷',
          description: '旧运行中已经冻结的分卷合同',
          startChapter: 1,
          endChapter: 40,
          objective: '建立据点',
          midpoint: '资源危机',
          climax: '守住据点',
          irreversibleCost: '失去退路',
          nextDebt: '外部敌人抵达',
          mustResolve: ['守住据点'],
          mayCarryForward: ['外部敌人'],
          forbiddenNewThreadsAfterChapter: 35,
          protagonistEndState: ['成为领袖'],
          antagonistEndState: ['先遣队失败']
        }]
      },
      volumePlanChecked: true,
      failure: {
        phase: 'draft_body',
        signature: 'old-run-failure',
        count: 6,
        message: '旧运行失败'
      }
    })
  })
  const novelReplacement = goalRoutineDAO.beginRun({
    workId: novelWorkId,
    workflowType: 'novel',
    resume: false,
    maxTurns: 600,
    currentPhase: 'generate_volumes',
    goalConfigJson: '{"maxTurns":600}'
  })
  assert.equal(novelReplacement.state_json, '{}')
  goalRoutineDAO.update(novelWorkId, {
    status: 'paused',
    state_json: JSON.stringify({
      failure: {
        phase: 'generate_volumes',
        step: 'generate_volumes',
        signature: 'misrouted-volume-plan',
        count: 4,
        message: '分卷规划规则已升级，但作品已有章节，不能自动重新分卷'
      }
    })
  })
  const materialized = ensureNovelAuthorityState(novelWorkId)
  assert.equal(materialized.created, true)
  assert.equal(materialized.sourceRunId, legacyRun.id)
  assert.equal(
    goalRoutineDAO.getByWork(novelWorkId)?.current_phase,
    'draft_body',
    '权威合同恢复后必须纠正历史错误重定向留下的阶段'
  )
  assert.equal(readNovelPersistentState(novelWorkId).novelOutline?.targetChapters, 800)
  assert.equal(readNovelPersistentState(novelWorkId).volumePlanChecked, true)
  assert.equal(
    readNovelPersistentState(novelWorkId).failure,
    undefined,
    '新运行不得继承旧运行的失败计数'
  )
  updateNovelPersistentState(novelWorkId, {
    failure: {
      phase: 'draft_body',
      step: 'body_generation',
      signature: 'new-run-failure',
      count: 1,
      message: '新运行失败'
    }
  })
  assert.equal(readNovelPersistentState(novelWorkId).failure?.count, 1)
  assert.equal(readNovelPersistentState(novelWorkId).novelOutline?.targetChapters, 800)
  const authorityRow = novelAuthorityStateDAO.get(novelWorkId)!
  assert.equal(authorityRow.source_run_id, legacyRun.id)
  assert.equal(
    JSON.parse(goalRoutineDAO.getByWork(novelWorkId)!.state_json).novelOutline,
    undefined,
    '运行状态不得重新持有作品级分卷合同'
  )

  const autonomousRecoveryWorkId = Number(db.prepare(
    "INSERT INTO works (title, work_type) VALUES ('自治恢复不变量', 'novel')"
  ).run().lastInsertRowid)
  const autonomousRecoveryRun = goalRoutineDAO.beginRun({
    workId: autonomousRecoveryWorkId,
    workflowType: 'novel',
    resume: false,
    maxTurns: 60,
    currentPhase: 'draft_body',
    goalConfigJson: '{"maxTurns":60,"autonomousMaxEpochs":20}'
  })
  goalRoutineDAO.update(autonomousRecoveryWorkId, {
    status: 'paused',
    desired_state: 'running'
  })
  const autonomousRecoverable = goalRoutineDAO.markInterruptedForRecovery()
    .find(item => item.id === autonomousRecoveryRun.id)
  assert.equal(autonomousRecoverable?.status, 'waiting')
  assert.equal(autonomousRecoverable?.desired_state, 'running')
  goalRoutineDAO.update(autonomousRecoveryWorkId, {
    status: 'error',
    desired_state: 'running',
    current_phase: 'repair_execute',
    state_json: JSON.stringify({
      repairPlan: {
        action: 'emotion',
        scope: 'chapter',
        targetChapterIds: [chapterId],
        hint: '情绪门禁未收敛'
      }
    })
  })
  const repairRecoverable = goalRoutineDAO.markInterruptedForRecovery()
    .find(item => item.id === autonomousRecoveryRun.id)
  assert.equal(repairRecoverable?.status, 'waiting')
  goalRoutineDAO.update(autonomousRecoveryWorkId, {
    status: 'error',
    desired_state: 'running',
    state_json: JSON.stringify({
      repairPlan: {
        action: 'emotion',
        scope: 'chapter',
        targetChapterIds: [chapterId],
        hint: '情绪门禁未收敛'
      },
      autonomousTerminal: {
        phase: 'repair_execute',
        code: 'MODEL_CONTRACT_UNAVAILABLE',
        message: '模型合同不可用',
        at: '2026-07-31T00:00:00.000Z'
      }
    })
  })
  assert.equal(
    goalRoutineDAO.markInterruptedForRecovery()
      .some(item => item.id === autonomousRecoveryRun.id),
    false
  )
  assert.equal(goalRoutineDAO.getByWork(autonomousRecoveryWorkId)?.status, 'error')
  goalRoutineDAO.update(autonomousRecoveryWorkId, {
    status: 'error',
    desired_state: 'running',
    current_phase: 'repair_execute',
    state_json: JSON.stringify({
      repairPlan: {
        action: 'quality',
        scope: 'chapter',
        targetChapterIds: [chapterId],
        hint: '历史协议错误恢复'
      },
      autonomousTerminal: {
        phase: 'repair_execute',
        code: 'CausalOutcomeProtocolError',
        message: 'relationships 不支持 set 操作',
        at: '2026-07-31T00:00:00.000Z'
      }
    })
  })
  const legacyProtocolRecovery = goalRoutineDAO.markInterruptedForRecovery()
    .find(item => item.id === autonomousRecoveryRun.id)
  assert.equal(legacyProtocolRecovery?.status, 'waiting')
  assert.equal(
    JSON.parse(legacyProtocolRecovery?.state_json ?? '{}').autonomousTerminal,
    undefined
  )
} finally {
  closeDatabase()
}

console.log('workflow runtime persistence and recovery tests passed')
