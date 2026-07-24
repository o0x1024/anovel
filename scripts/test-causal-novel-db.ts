import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  CAUSAL_NOVEL_SCHEMA_VERSION,
  formatCausalDecisionCard,
  type CausalChapterOutcome,
  type CausalChapterPlan,
  type CausalNarrativeState
} from '../src/shared/causal-novel-types'
import { ensureIncrementalMigrations } from '../src/main/db/migrations'

async function main(): Promise<void> {
  const { closeDatabase, getDatabase, injectDatabaseForTest } = await import('../src/main/db/connection')
  injectDatabaseForTest(new Database(':memory:'))
  const {
    causalNovelDAO,
    coreSettingDAO,
    initSchema,
    volumeChapterDAO,
    workDAO,
    writingStyleDAO
  } = await import('../src/main/db')
  const { collectPromptSections } = await import('../src/main/context/context-budget')
  const {
    ensureChapterEmotionContract,
    loadChapterEmotionContract,
    loadEmotionEngine
  } = await import('../src/main/context/goal-routine/emotion-engine')
  const {
    applyCausalStyleRewrite,
    buildCausalRewriteValidationToken,
    collectCausalRewriteEvidenceAnchors,
    validateCausalRewriteCandidate
  } = await import('../src/main/context/causal-chapter-style-rewrite')
  initSchema()

  try {
    const workId = workDAO.create({
      title: '因果作品', workType: 'causal_novel', description: '寿命可以交易', genre: '悬疑'
    })
    assert.equal(workDAO.list('causal_novel').length, 1)
    assert.equal(workDAO.list('novel').length, 0)
    assert.equal(workDAO.getById(workId)?.genre, '悬疑')

    const state: CausalNarrativeState = {
      schemaVersion: CAUSAL_NOVEL_SCHEMA_VERSION,
      revision: 0,
      centralQuestion: '主角是否公开真相？',
      terminalConditions: ['主角作出不可逆选择'],
      immutableRules: ['寿命转移不可撤销'],
      actors: [
        { name: '林舟', currentGoal: '救母亲', fear: '失去母亲', knowledge: [], resources: [], constraint: '时间不足' },
        { name: '周岚', currentGoal: '查明真相', fear: '证据消失', knowledge: [], resources: [], constraint: '没有证据' }
      ],
      activePressures: [{
        id: 'p1', source: '黑市', target: '林舟', condition: '正在追查', escalation: '身份暴露', urgency: 7, status: 'active'
      }],
      promises: [{ id: 'q1', question: '能力从何而来？', status: 'open', openedChapter: 0, lastAdvancedChapter: 0 }],
      macroArcs: [{
        id: 'arc_truth', title: '追查黑市', objective: '确认寿命交易真相',
        entryConditions: ['黑市存在'], exitConditions: ['真相确认'],
        mandatoryPayoffs: ['能力来源'], forbiddenDrift: ['寿命不可恢复'],
        status: 'active', lastAdvancedChapter: 0
      }],
      macroArchitectureReady: true,
      archivedPromiseIds: [], recentEventSignatures: [],
      completionStatus: 'writing', completionAuditFeedback: [],
      completed: false, completionReason: ''
    }
    causalNovelDAO.createState(workId, state)
    assert.equal(causalNovelDAO.listStateRevisions(workId).length, 1)
    assert.equal(causalNovelDAO.getStateRevision(workId, 0)?.transitionType, 'initial')
    causalNovelDAO.recordPlanAttempt({
      workId,
      stateRevision: 0,
      stage: 'local_validation',
      status: 'rejected',
      errorCode: 'PLAN_IDENTITY',
      errorMessage: '发起人必须是单一权威人物',
      responseJson: '{"initiator":"林舟、周岚"}'
    })
    const rejectedAttempt = causalNovelDAO.listPlanAttempts(workId, 1)[0]
    assert.equal(rejectedAttempt.errorCode, 'PLAN_IDENTITY')
    assert.equal(rejectedAttempt.responseHash?.length, 64)
    assert.match(rejectedAttempt.responseJson ?? '', /林舟、周岚/)

    const plan: CausalChapterPlan = {
      candidates: [{
        id: 'c1', initiator: '林舟', action: '潜入黑市', opposition: '守卫盘查', cost: '暴露身份',
        irreversibleChange: '身份进入追查名单', promiseAdvanced: 'q1', newQuestion: '父亲是谁？',
        scores: {
          causalNecessity: 90, promiseProgress: 90, irreversibleImpact: 85,
          novelty: 80, pressureEscalation: 88, total: 88
        }
      }, {
        id: 'c2', initiator: '周岚', action: '查病历', opposition: '权限不足', cost: '遭到警告',
        irreversibleChange: '调查被上级知晓', promiseAdvanced: 'q1', newQuestion: '谁删除病历？',
        scores: {
          causalNecessity: 70, promiseProgress: 75, irreversibleImpact: 70,
          novelty: 70, pressureEscalation: 72, total: 72
        }
      }, {
        id: 'c3', initiator: '林舟', action: '等待消息', opposition: '母亲恶化', cost: '错失时间',
        irreversibleChange: '母亲病情恶化', promiseAdvanced: 'q1', newQuestion: '还能否救治？',
        scores: {
          causalNecessity: 50, promiseProgress: 40, irreversibleImpact: 60,
          novelty: 30, pressureEscalation: 60, total: 48
        }
      }],
      selectedCandidateId: 'c1',
      decision: {
        title: '潜入黑市', pov: '林舟', initiator: '林舟', immediateWant: '找到寿命来源',
        chosenAction: '潜入黑市', opposition: '守卫盘查', cost: '暴露身份', openingState: '林舟抵达黑市入口',
        mustCover: ['林舟接受盘查', '林舟进入黑市'], forbiddenEvents: ['不得揭示终局真相'],
        endingState: '林舟被列入追查名单', continuityConstraints: ['母亲仍在医院'],
        characters: ['林舟', '守卫'], advancedPromiseIds: ['q1'], newQuestion: '父亲是谁？'
      },
      emotionContract: {
        pov_character: '林舟', attachment_anchor: '林舟潜入黑市是为了救仍在医院的母亲',
        value_at_stake: '母亲获救的机会与林舟的匿名身份',
        reader_state_before: { label: '紧张', valence: -1, arousal: 2, agency: -1, certainty: 2 },
        trigger_event: '守卫开始盘查林舟',
        character_appraisal: {
          perceived_meaning: '退缩就会失去救母亲的机会', blame_or_cause: '黑市守卫',
          controllability: '可以冒险伪装通过', certainty: '中等确定', value_or_norm_violated: '母亲的生命不能被黑市定价'
        },
        character_layers: {
          felt: '恐惧与决绝', admitted: '承认自己没有退路', displayed: '装作熟客接受盘查',
          suppressed: '害怕身份暴露', action_impulse: '继续潜入'
        },
        information_position: {
          reader_knows: '林舟可能暴露身份', pov_knows: '母亲时间不足', other_knows: '守卫掌握盘查规则',
          gap_type: 'reader_equal'
        },
        choice_and_cost: '林舟选择接受盘查进入黑市，代价是身份进入追查名单',
        private_detail_anchor: '林舟救母亲', subtext_or_omission: '林舟不解释救人的目的',
        reader_state_after: { label: '担忧', valence: -1, arousal: 3, agency: 0, certainty: 1 },
        arc_role: 'build', emotional_debt_opened: '身份暴露可能牵连母亲', emotional_debt_paid: '',
        residue_into_next: '林舟之后每次使用能力都要考虑追查名单',
        grounding_refs: ['actor:林舟', 'pressure:p1', 'promise:q1'],
        grounded_claims: [
          { field: 'attachment_anchor', ref: 'actor:林舟', evidence: '救母亲' },
          { field: 'private_detail_anchor', ref: 'actor:林舟', evidence: '救母亲' }
        ]
      },
      rollingHorizon: Array.from({ length: 5 }, (_, offset) => ({
        offset, objective: offset === 0 ? '潜入黑市' : `继续追查线索${offset}`,
        initiator: '林舟', pressureIds: ['p1'], promiseIds: ['q1'],
        expectedIrreversibleChange: `确认线索${offset + 1}`, replanningTrigger: '黑市压力发生变化'
      }))
    }
    const chapterId = causalNovelDAO.createPlannedChapter({
      workId, stateRevision: 0, plan, decisionCard: formatCausalDecisionCard(plan)
    })
    assert.equal(volumeChapterDAO.listVolumes(workId)[0].name, '滚动正文')
    assert.equal(causalNovelDAO.getDecision(chapterId)?.status, 'planned')
    assert.match(volumeChapterDAO.getChapter(chapterId)?.emotion_contract_json ?? '', /grounding_refs/)
    assert.equal(loadChapterEmotionContract(chapterId)?.pov_character, '林舟')

    const styleId = writingStyleDAO.create({
      name: '因果正文测试文风',
      prompt_template: '【文风要求】短句推进，保持第三人称限知。',
      reference_text: '林舟停在门前。门后有人。那人正在等他。',
      step_rules_json: JSON.stringify({
        identity: { emotional_core: ['紧张'], target_reader: '悬疑读者', style_keywords: ['短句'] },
        decision_rules: ['当危险逼近时 → 先写动作，再揭示判断'],
        pacing_rules: {
          conflict_interval: '每场至少一次阻力变化',
          payoff_interval: '章内至少一次阶段回报',
          chapter_end_must: ['未解威胁'],
          emotion_loop: ['受压', '选择', '付代价']
        },
        quality_checklist: []
      })
    })
    writingStyleDAO.setWorkStyle(workId, styleId)
    const repairSectionKeys = collectPromptSections({
      workId,
      chapterId,
      step: 'novel_execution_repair',
      prompt: '修复完整正文',
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }).map(section => section.key)
    assert(repairSectionKeys.includes('style'))
    assert(repairSectionKeys.includes('style_step_rules'))
    assert(repairSectionKeys.includes('style_fewshot'))

    const outcome: CausalChapterOutcome = {
      summary: '林舟进入黑市。', eventSignature: '林舟潜入黑市', evidenceQuotes: ['林舟进入黑市'],
      advancedPromiseIds: ['q1'], resolvedPromiseIds: [], newPromises: [], actorUpdates: [],
      newActors: [], pressureUpdates: [], newPressures: [], arcUpdates: [],
      emotionalOutcome: {
        readerEffectSummary: '林舟进入黑市但身份风险上升。', triggerEvidence: '林舟进入黑市',
        choiceEvidence: '林舟进入黑市', costEvidence: '林舟进入黑市', residueEvidence: '林舟进入黑市',
        emotionalDebtOpened: '身份进入追查名单', emotionalDebtPaid: ''
      },
      terminalConditionMet: false, matchedTerminalCondition: '', terminalEvidence: '', completionReason: ''
    }
    const nextState: CausalNarrativeState = {
      ...state, revision: 1,
      promises: [{ ...state.promises[0], status: 'advanced', lastAdvancedChapter: 1 }],
      recentEventSignatures: ['林舟潜入黑市']
    }
    assert.throws(() => causalNovelDAO.commitDecision({
      workId, chapterId, expectedStateRevision: 0, nextState, outcome,
      expectedBodyHash: 'not-the-current-body-hash'
    }), /正文已在因果提取后发生变化/)
    assert.equal(causalNovelDAO.getState(workId)?.revision, 0)
    assert.throws(() => getDatabase().transaction(() => {
      causalNovelDAO.commitDecision({
        workId, chapterId, expectedStateRevision: 0, nextState, outcome
      })
      throw new Error('模拟同事务内的章节完成写入失败')
    })(), /模拟同事务/)
    assert.equal(causalNovelDAO.getState(workId)?.revision, 0)
    assert.equal(causalNovelDAO.getDecision(chapterId)?.status, 'planned')
    assert.equal(causalNovelDAO.listStateRevisions(workId).length, 1)

    causalNovelDAO.commitDecision({
      workId, chapterId, expectedStateRevision: 0, nextState, outcome
    })
    assert.equal(causalNovelDAO.getState(workId)?.revision, 1)
    assert.equal(causalNovelDAO.getDecision(chapterId)?.status, 'committed')
    assert.equal(causalNovelDAO.getStateRevision(workId, 1)?.transitionType, 'chapter_commit')
    assert.equal(causalNovelDAO.getStateRevision(workId, 1)?.sourceChapterId, chapterId)
    assert.equal(causalNovelDAO.getStateRevision(workId, 1)?.bodyHash?.length, 64)
    assert.throws(() => causalNovelDAO.commitDecision({
      workId, chapterId, expectedStateRevision: 0, nextState, outcome
    }), /已经提交或拒绝/)

    const originalBody = '林舟站在入口，随后推门。林舟进入黑市，守卫抬头记住了他的脸。'
    const rewrittenBody = '入口没有灯。林舟进入黑市，守卫抬起眼，记住了他的脸；他径直往里走。'
    volumeChapterDAO.updateChapter(chapterId, {
      content: originalBody,
      word_count: originalBody.replace(/\s/g, '').length
    })
    const committedDecision = causalNovelDAO.getDecision(chapterId)
    const evidenceAnchors = collectCausalRewriteEvidenceAnchors({
      decision: committedDecision,
      stateFacts: [],
      emotionalStates: []
    })
    assert.deepEqual(evidenceAnchors, ['林舟进入黑市'])
    assert.equal(validateCausalRewriteCandidate(originalBody, rewrittenBody, evidenceAnchors).passed, true)
    assert.equal(validateCausalRewriteCandidate(originalBody, '林舟去了别处。', evidenceAnchors).passed, false)
    const chapterBeforeRewrite = volumeChapterDAO.getChapter(chapterId)!
    const validationToken = buildCausalRewriteValidationToken({
      workId,
      chapterId,
      updateTime: chapterBeforeRewrite.update_time,
      stateRevision: committedDecision?.stateRevision ?? null,
      candidateContent: rewrittenBody,
      evidenceAnchors
    })
    assert.equal(applyCausalStyleRewrite({
      workId,
      chapterId,
      candidateContent: rewrittenBody,
      expectedUpdateTime: chapterBeforeRewrite.update_time,
      validationToken
    }), true)
    assert.notEqual(volumeChapterDAO.getChapter(chapterId)?.content, originalBody)
    assert.match(volumeChapterDAO.getChapter(chapterId)?.content ?? '', /林舟进入黑市/)
    assert.match(volumeChapterDAO.listVersions(chapterId)[0].content ?? '', /随后推门/)
    assert.notEqual(volumeChapterDAO.listVersions(chapterId)[0].content, volumeChapterDAO.getChapter(chapterId)?.content)
    assert.equal(volumeChapterDAO.listVersions(chapterId)[0].model_type, 'causal_style_rewrite')
    assert.equal(causalNovelDAO.getState(workId)?.revision, 1)
    assert.equal(causalNovelDAO.getDecision(chapterId)?.status, 'committed')
    const rewriteBinding = causalNovelDAO.getChapterBinding(chapterId)
    assert.equal(rewriteBinding?.bindingStatus, 'active')
    assert.equal(rewriteBinding?.stateBeforeRevision, 0)
    assert.equal(rewriteBinding?.stateAfterRevision, 1)
    const immutableVersions = causalNovelDAO.listContentVersions(chapterId)
    assert.ok(immutableVersions.length >= 2)
    assert.equal(immutableVersions[0].source, 'ai_style_rewrite')
    assert.equal(immutableVersions[0].status, 'active')
    assert.equal(immutableVersions[0].bodyHash.length, 64)

    const factualCandidate = causalNovelDAO.createContentVersion({
      workId,
      chapterId,
      parentVersionId: immutableVersions[0].id,
      content: `${rewrittenBody}林舟决定不再进入黑市。`,
      source: 'manual',
      editKind: 'factual',
      status: 'candidate'
    })
    const replay = causalNovelDAO.queueReplay({
      workId,
      chapterId,
      baseStateRevision: 0,
      sourceVersionId: immutableVersions[0].id,
      targetVersionId: factualCandidate.id,
      editKind: 'factual',
      affectedChapterIds: []
    })
    assert.equal(replay.status, 'pending')
    assert.equal(causalNovelDAO.getPendingReplay(workId)?.targetVersionId, factualCandidate.id)
    assert.equal(causalNovelDAO.getChapterBinding(chapterId)?.bindingStatus, 'pending_replay')
    causalNovelDAO.blockReplay(replay.id, chapterId, '后续章节证据冲突')
    assert.equal(causalNovelDAO.getPendingReplay(workId)?.status, 'blocked')
    causalNovelDAO.retryReplay(replay.id)
    assert.equal(causalNovelDAO.getPendingReplay(workId)?.status, 'pending')
    causalNovelDAO.cancelReplay(replay.id)
    assert.equal(causalNovelDAO.getReplayJob(replay.id)?.status, 'cancelled')

    const beforeProposal = causalNovelDAO.getState(workId)!
    const proposedState: CausalNarrativeState = {
      ...beforeProposal,
      revision: 2,
      completionStatus: 'proposed',
      completed: false,
      completionReason: '主角已经作出不可逆选择'
    }
    causalNovelDAO.replaceState(workId, 1, proposedState, { transitionType: 'test_completion_proposed' })
    const reopened = causalNovelDAO.rejectProposedCompletion(workId, 2, ['整书终审仍缺少承诺兑现'])
    assert.equal(reopened.revision, 3)
    assert.equal(reopened.completionStatus, 'writing')
    assert.deepEqual(reopened.completionAuditFeedback, ['整书终审仍缺少承诺兑现'])
    causalNovelDAO.replaceState(workId, 3, {
      ...reopened,
      revision: 4,
      completionStatus: 'proposed',
      completionReason: '主角已经作出不可逆选择'
    }, { transitionType: 'test_completion_proposed' })
    const atomicityReplay = causalNovelDAO.queueReplay({
      workId,
      chapterId,
      baseStateRevision: 0,
      sourceVersionId: immutableVersions[0].id,
      targetVersionId: factualCandidate.id,
      editKind: 'factual',
      affectedChapterIds: []
    })
    assert.throws(() => getDatabase().transaction(() => {
      causalNovelDAO.confirmCompletion(workId, 4, '不应单独提交的完结状态')
      causalNovelDAO.createReleaseSnapshot(workId)
    })(), /未完成因果重放/)
    assert.equal(causalNovelDAO.getState(workId)?.revision, 4)
    assert.equal(causalNovelDAO.getState(workId)?.completionStatus, 'proposed')
    causalNovelDAO.cancelReplay(atomicityReplay.id)
    causalNovelDAO.activateContentVersion({
      workId,
      chapterId,
      contentVersionId: immutableVersions[0].id,
      stateBeforeRevision: 0,
      stateAfterRevision: 1,
      decisionStatus: 'committed',
      bindingStatus: 'active'
    })
    const releaseResult = getDatabase().transaction(() => {
      const completed = causalNovelDAO.confirmCompletion(workId, 4, '独立终审确认完成')
      const snapshotId = causalNovelDAO.createReleaseSnapshot(workId)
      return { completed, snapshotId }
    })()
    const { completed } = releaseResult
    assert.equal(completed.revision, 5)
    assert.equal(completed.completionStatus, 'completed')
    assert.equal(completed.completed, true)
    assert.equal(causalNovelDAO.getStateRevision(workId, 5)?.transitionType, 'completion_confirmed')
    const releaseSnapshot = getDatabase().prepare(
      'SELECT content_hash, snapshot_json, is_frozen FROM story_release_snapshots WHERE id = ?'
    ).get(releaseResult.snapshotId) as { content_hash: string; snapshot_json: string; is_frozen: number }
    assert.equal(releaseSnapshot.is_frozen, 1)
    assert.equal(releaseSnapshot.content_hash.length, 64)
    assert.match(releaseSnapshot.snapshot_json, /causal_novel_release_v1/)
    assert.match(releaseSnapshot.snapshot_json, /activeContentVersions/)

    coreSettingDAO.upsert(workId, 'emotion_engine', '错误传统情绪发动机第一版')
    coreSettingDAO.upsert(workId, 'emotion_engine', '错误传统情绪发动机第二版')
    assert.ok(coreSettingDAO.getByType(workId, 'emotion_engine'))
    assert.equal(loadEmotionEngine(workId), null)

    const legacyWorkId = workDAO.create({
      title: '旧因果草稿', workType: 'causal_novel', description: '用于迁移测试'
    })
    const legacyVolumeId = volumeChapterDAO.createVolume(legacyWorkId, '滚动正文')
    const legacyChapterId = volumeChapterDAO.createChapter(legacyVolumeId, '旧决策')
    getDatabase().prepare(
      `INSERT INTO causal_chapter_decisions (
        chapter_id, work_id, state_revision, status, plan_json
      ) VALUES (?, ?, 0, 'planned', '{}')`
    ).run(legacyChapterId, legacyWorkId)
    await assert.rejects(
      () => ensureChapterEmotionContract(legacyWorkId, legacyChapterId),
      /禁止回退到传统全书情绪发动机/
    )

    getDatabase().exec('DROP TABLE causal_state_revisions')
    ensureIncrementalMigrations(getDatabase())
    assert.equal(causalNovelDAO.listStateRevisions(workId).length, 1)
    assert.equal(causalNovelDAO.getStateRevision(workId, 5)?.transitionType, 'legacy_snapshot')
    assert.equal(coreSettingDAO.getByType(workId, 'emotion_engine'), undefined)
    assert.equal(coreSettingDAO.listVersions(workId, 'emotion_engine').length, 0)
    assert.equal(volumeChapterDAO.getChapter(legacyChapterId), undefined)
  } finally {
    closeDatabase()
  }

  console.log('causal novel db tests passed')
}

void main()
