import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

async function main(): Promise<void> {
  const { closeDatabase, getDatabase, injectDatabaseForTest } = await import('../src/main/db/connection')
  injectDatabaseForTest(new Database(':memory:'))
  const {
    chapterEmotionCheckpointDAO,
    emotionalStateDAO,
    goalRoutineDAO,
    initSchema,
    novelChapterAcceptanceDAO,
    workDAO,
    volumeChapterDAO
  } = await import('../src/main/db')
  initSchema()
  const { commitPreparedNarrativeMemory, NarrativeMemoryCommitGateError } = await import(
    '../src/main/context/goal-routine/story-goal-doer'
  )
  const { runConsistencyGate } = await import('../src/main/context/consistency-gate')
  const { parseMemoryExtract } = await import('../src/main/context/memory-extract')
  const { recoverNarrativeMemoryCommitGate } = await import(
    '../src/main/context/goal-routine/novel-autonomous-control'
  )
  const { novelChapterContentHash } = await import(
    '../src/main/context/goal-routine/novel-chapter-acceptance-policy'
  )

  try {
    const workId = workDAO.create({ title: '原子记忆测试', workType: 'novel' })
    const volumeId = volumeChapterDAO.createVolume(workId, '第一卷')
    const chapterId = volumeChapterDAO.createChapter(volumeId, '第一章', '测试大纲')
    const sourceContent = '陈凉把铁片递给小满，随后两人离开废墟。'
    volumeChapterDAO.updateChapter(chapterId, {
      content: sourceContent,
      word_count: sourceContent.length,
      status: 'draft'
    })

    const candidateGate = runConsistencyGate(workId, chapterId, sourceContent, { requireTimeline: false })
    assert.equal(candidateGate.passed, true)
    const prematureCommittedGate = runConsistencyGate(workId, chapterId, sourceContent)
    assert.equal(prematureCommittedGate.passed, false)
    assert.match(prematureCommittedGate.blockers.join('；'), /缺少关键事件与时间推进记录/)

    const prepared = {
      sourceContent,
      warnings: [],
      resolutions: { resolved: [], partial: [], pending: [] },
      extracted: {
        foreshadowing_planted: [{ description: '铁片来源仍然不明', depth: 'normal' as const }],
        foreshadowing_resolved: [],
        character_snapshots: [{ character_name: '陈凉', location: '废墟外' }],
        timeline_events: [{ event_name: '离开废墟', relative_time: '当日' }],
        state_facts: [],
        chapter_pattern: {
          conflictType: '资源冲突',
          protagonistMethod: '交换',
          antagonistTactic: '封锁',
          antagonistOutcome: '暂时脱身',
          opponentAdjustment: '追踪',
          locationType: '废墟',
          hookType: '线索',
          costType: '资源',
          relationshipDelta: '初步信任',
          volumeObjectiveDelta: '获得同伴',
          payoffType: 'partial' as const
        }
      }
    }

    const memoryJson = JSON.stringify(prepared.extracted)
    assert.equal(parseMemoryExtract(memoryJson).timeline_events?.length, 1)
    assert.throws(
      () => parseMemoryExtract(JSON.stringify({
        ...prepared.extracted,
        timeline_events: [{ event_name: '', relative_time: '当日' }]
      })),
      /有效的关键时间线事件/
    )
    const missingTime = parseMemoryExtract(JSON.stringify({
        ...prepared.extracted,
        timeline_events: [{ event_name: '离开废墟' }]
      }))
    assert.equal(missingTime.timeline_events?.[0]?.relative_time, '本章内')
    const placeholderTime = parseMemoryExtract(JSON.stringify({
      ...prepared.extracted,
      timeline_events: [{ event_name: '离开废墟', relative_time: 'relative_time' }]
    }))
    assert.equal(placeholderTime.timeline_events?.[0]?.relative_time, '本章内')

    let gateError: unknown
    try {
      commitPreparedNarrativeMemory(workId, chapterId, prepared, {
        markChapterCompleted: true,
        validate: () => ['注入的资源门禁失败']
      })
    } catch (error) {
      gateError = error
    }
    assert.ok(gateError instanceof NarrativeMemoryCommitGateError)
    assert.equal(gateError.code, 'NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED')
    assert.equal(gateError.chapterId, chapterId)
    assert.deepEqual(gateError.blockers, ['注入的资源门禁失败'])

    const db = getDatabase()
    const count = (table: string): number => Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    )

    const recoveryChapterId = volumeChapterDAO.createChapter(
      volumeId,
      '第二章',
      '重复钩子恢复测试'
    )
    const recoveryContent = '陈凉没有重复上一章的钩子，她把目标改成封住楼梯口。'
    volumeChapterDAO.updateChapter(recoveryChapterId, {
      content: recoveryContent,
      word_count: recoveryContent.length,
      status: 'draft'
    })
    const recoveryRun = goalRoutineDAO.beginRun({
      workId,
      workflowType: 'novel',
      resume: false,
      maxTurns: 30,
      currentPhase: 'draft_body',
      goalConfigJson: '{}'
    })
    const recoveryHash = novelChapterContentHash(recoveryContent)
    const recoveryEpisode = novelChapterAcceptanceDAO.createEpisode({
      episodeKey: `memory-recovery:${recoveryChapterId}:${recoveryHash}`,
      workId,
      chapterId: recoveryChapterId,
      runId: recoveryRun.id,
      baseContentHash: recoveryHash,
      contractHash: 'memory-recovery-contract',
      protocolVersion: 3,
      maxAssessments: 1,
      maxRepairs: 1
    })
    const recoveryCandidate = novelChapterAcceptanceDAO.addCandidate({
      episodeId: recoveryEpisode.id,
      contentHash: recoveryHash,
      sourceKind: 'baseline',
      content: recoveryContent,
      wordCount: recoveryContent.length
    })
    novelChapterAcceptanceDAO.setBestCandidate(recoveryEpisode.id, recoveryCandidate.id)
    novelChapterAcceptanceDAO.finish(recoveryEpisode.id, { status: 'accepted' })
    const recoveryPlan = recoverNarrativeMemoryCommitGate({
      workId,
      chapterId: recoveryChapterId,
      blockers: ['跨章状态/模式[REPEATED_HOOK]：重复章末钩子']
    })
    assert.equal(recoveryPlan.action, 'cluster')
    assert.equal(
      novelChapterAcceptanceDAO.getEpisode(recoveryEpisode.id)?.status,
      'superseded',
      '普通正文的已接受候选必须能直接路由到记忆域结构修复'
    )
    assert.equal(count('foreshadowing'), 0)
    assert.equal(count('character_snapshots'), 0)
    assert.equal(count('story_timeline'), 0)
    assert.equal(count('chapter_pattern_fingerprints'), 0)
    assert.equal(volumeChapterDAO.getChapter(chapterId)?.status, 'draft')

    const missingTimelinePrepared = {
      ...prepared,
      extracted: { ...prepared.extracted, timeline_events: [] }
    }
    assert.throws(
      () => commitPreparedNarrativeMemory(workId, chapterId, missingTimelinePrepared, {
        markChapterCompleted: true,
        validate: () => runConsistencyGate(workId, chapterId, sourceContent).blockers
      }),
      /时间线/
    )
    assert.equal(count('foreshadowing'), 0)
    assert.equal(count('character_snapshots'), 0)
    assert.equal(count('story_timeline'), 0)
    assert.equal(count('chapter_pattern_fingerprints'), 0)
    assert.equal(volumeChapterDAO.getChapter(chapterId)?.status, 'draft')

    const committed = commitPreparedNarrativeMemory(workId, chapterId, prepared, {
      markChapterCompleted: true,
      validate: () => runConsistencyGate(workId, chapterId, sourceContent).blockers
    })
    assert.equal(committed.planted, 1)
    assert.equal(committed.snapshots, 1)
    assert.equal(committed.timelineEvents, 1)
    assert.equal(committed.patternFingerprint, true)
    assert.equal(volumeChapterDAO.getChapter(chapterId)?.status, 'completed')

    chapterEmotionCheckpointDAO.complete({
      workId,
      chapterId,
      contentHash: 'emotion-hash-v3',
      stage: 'blind_read',
      payload: { score: 88 }
    })
    chapterEmotionCheckpointDAO.fail({
      workId,
      chapterId,
      contentHash: 'emotion-hash-v3',
      stage: 'ledger_batch',
      batchKey: '001:陈凉',
      failureCode: 'EMOTION_LEDGER_TRUNCATED',
      failureMessage: 'finishReason=length'
    })
    chapterEmotionCheckpointDAO.complete({
      workId,
      chapterId,
      contentHash: 'emotion-hash-v3',
      stage: 'ledger_batch',
      batchKey: '000:陈凉',
      payload: [{ character_name: '陈凉' }]
    })
    assert.equal(
      chapterEmotionCheckpointDAO.find(chapterId, 'emotion-hash-v3', 'blind_read')?.status,
      'completed'
    )
    assert.equal(
      chapterEmotionCheckpointDAO.find(chapterId, 'emotion-hash-v3', 'ledger_batch', '001:陈凉')?.attempt_count,
      1
    )
    chapterEmotionCheckpointDAO.complete({
      workId,
      chapterId,
      contentHash: 'emotion-hash-v3',
      stage: 'ledger_batch',
      batchKey: '001:陈凉',
      payload: [{ character_name: '陈凉' }]
    })
    assert.equal(
      chapterEmotionCheckpointDAO.listCompleted(
        chapterId,
        'emotion-hash-v3',
        'ledger_batch'
      ).length,
      2
    )
    chapterEmotionCheckpointDAO.complete({
      workId,
      chapterId,
      contentHash: 'stale-emotion-hash',
      stage: 'blind_read',
      payload: { score: 1 }
    })
    assert.equal(chapterEmotionCheckpointDAO.deleteStale(chapterId, 'emotion-hash-v3'), 1)
    assert.equal(
      chapterEmotionCheckpointDAO.find(chapterId, 'emotion-hash-v3', 'blind_read')?.status,
      'completed'
    )
    emotionalStateDAO.replaceChapterOutcome(chapterId, [{
      work_id: workId,
      chapter_id: chapterId,
      character_name: '陈凉',
      felt_state: '警惕',
      displayed_state: '沉默',
      unresolved_emotion: '担心追兵',
      protective_strategy: '先观察',
      behavioral_aftereffect: '下一章会先确认退路',
      beliefs_json: '[]',
      relationships_json: '[]',
      source_event: '离开废墟'
    }], JSON.stringify({ passed: true }), 6)
    assert.equal(count('chapter_emotion_checkpoints'), 0)
    assert.equal(count('emotional_state_ledger'), 1)

    const replacement = {
      ...prepared,
      extracted: {
        ...prepared.extracted,
        character_snapshots: [{ character_name: '陈凉', location: '错误候选位置' }]
      }
    }
    assert.throws(
      () => commitPreparedNarrativeMemory(workId, chapterId, replacement, {
        validate: () => ['替换候选门禁失败']
      }),
      /替换候选门禁失败/
    )
    assert.equal(count('character_snapshots'), 1)
    assert.equal(
      (db.prepare('SELECT location FROM character_snapshots WHERE chapter_id = ?').get(chapterId) as { location: string }).location,
      '废墟外'
    )

    volumeChapterDAO.updateChapter(chapterId, { content: `${sourceContent}正文已重写。`, status: 'draft' })
    assert.throws(
      () => commitPreparedNarrativeMemory(workId, chapterId, prepared, { markChapterCompleted: true }),
      /候选正文已变化/
    )
    assert.equal(count('character_snapshots'), 1)
    assert.equal(volumeChapterDAO.getChapter(chapterId)?.status, 'draft')
  } finally {
    closeDatabase()
  }

  console.log('novel narrative memory atomic commit tests passed')
}

void main()
