import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

async function main(): Promise<void> {
  const { closeDatabase, getDatabase, injectDatabaseForTest } = await import('../src/main/db/connection')
  injectDatabaseForTest(new Database(':memory:'))
  const { initSchema, workDAO, volumeChapterDAO } = await import('../src/main/db')
  initSchema()
  const { commitPreparedNarrativeMemory } = await import(
    '../src/main/context/goal-routine/story-goal-doer'
  )
  const { runConsistencyGate } = await import('../src/main/context/consistency-gate')
  const { parseMemoryExtract } = await import('../src/main/context/memory-extract')

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

    assert.throws(
      () => commitPreparedNarrativeMemory(workId, chapterId, prepared, {
        markChapterCompleted: true,
        validate: () => ['注入的资源门禁失败']
      }),
      /注入的资源门禁失败/
    )

    const db = getDatabase()
    const count = (table: string): number => Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
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
