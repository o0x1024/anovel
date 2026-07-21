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
  const { causalNovelDAO, coreSettingDAO, initSchema, volumeChapterDAO, workDAO } = await import('../src/main/db')
  const {
    ensureChapterEmotionContract,
    loadChapterEmotionContract,
    loadEmotionEngine
  } = await import('../src/main/context/goal-routine/emotion-engine')
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
      recentEventSignatures: [], completed: false, completionReason: ''
    }
    causalNovelDAO.createState(workId, state)

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
        private_detail_anchor: '母亲的住院腕带', subtext_or_omission: '林舟不解释救人的目的',
        reader_state_after: { label: '担忧', valence: -1, arousal: 3, agency: 0, certainty: 1 },
        arc_role: 'build', emotional_debt_opened: '身份暴露可能牵连母亲', emotional_debt_paid: '',
        residue_into_next: '林舟之后每次使用能力都要考虑追查名单',
        grounding_refs: ['actor:林舟', 'pressure:p1', 'promise:q1']
      }
    }
    const chapterId = causalNovelDAO.createPlannedChapter({
      workId, stateRevision: 0, plan, decisionCard: formatCausalDecisionCard(plan)
    })
    assert.equal(volumeChapterDAO.listVolumes(workId)[0].name, '滚动正文')
    assert.equal(causalNovelDAO.getDecision(chapterId)?.status, 'planned')
    assert.match(volumeChapterDAO.getChapter(chapterId)?.emotion_contract_json ?? '', /grounding_refs/)
    assert.equal(loadChapterEmotionContract(chapterId)?.pov_character, '林舟')

    const outcome: CausalChapterOutcome = {
      summary: '林舟进入黑市。', eventSignature: '林舟潜入黑市', evidenceQuotes: ['林舟进入黑市'],
      advancedPromiseIds: ['q1'], resolvedPromiseIds: [], newPromises: [], actorUpdates: [],
      pressureUpdates: [], newPressures: [],
      emotionalOutcome: {
        readerEffectSummary: '林舟进入黑市但身份风险上升。', triggerEvidence: '林舟进入黑市',
        choiceEvidence: '林舟进入黑市', costEvidence: '林舟进入黑市', residueEvidence: '林舟进入黑市',
        emotionalDebtOpened: '身份进入追查名单', emotionalDebtPaid: ''
      },
      terminalConditionMet: false, completionReason: ''
    }
    const nextState: CausalNarrativeState = {
      ...state, revision: 1,
      promises: [{ ...state.promises[0], status: 'advanced', lastAdvancedChapter: 1 }],
      recentEventSignatures: ['林舟潜入黑市']
    }
    assert.throws(() => getDatabase().transaction(() => {
      causalNovelDAO.commitDecision({
        workId, chapterId, expectedStateRevision: 0, nextState, outcome
      })
      throw new Error('模拟同事务内的章节完成写入失败')
    })(), /模拟同事务/)
    assert.equal(causalNovelDAO.getState(workId)?.revision, 0)
    assert.equal(causalNovelDAO.getDecision(chapterId)?.status, 'planned')

    causalNovelDAO.commitDecision({
      workId, chapterId, expectedStateRevision: 0, nextState, outcome
    })
    assert.equal(causalNovelDAO.getState(workId)?.revision, 1)
    assert.equal(causalNovelDAO.getDecision(chapterId)?.status, 'committed')
    assert.throws(() => causalNovelDAO.commitDecision({
      workId, chapterId, expectedStateRevision: 0, nextState, outcome
    }), /已经提交或拒绝/)

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

    ensureIncrementalMigrations(getDatabase())
    assert.equal(coreSettingDAO.getByType(workId, 'emotion_engine'), undefined)
    assert.equal(coreSettingDAO.listVersions(workId, 'emotion_engine').length, 0)
    assert.equal(volumeChapterDAO.getChapter(legacyChapterId), undefined)
  } finally {
    closeDatabase()
  }

  console.log('causal novel db tests passed')
}

void main()
