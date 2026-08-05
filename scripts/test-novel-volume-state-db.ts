import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

const contract = (name: string, startChapter: number, endChapter: number) => ({
  name,
  description: `${name}说明`,
  startChapter,
  endChapter,
  objective: '卷目标',
  midpoint: '中点',
  climax: '高潮',
  irreversibleCost: '代价',
  nextDebt: '后续债务',
  mustResolve: ['本卷问题'],
  mayCarryForward: ['长线伏笔'],
  forbiddenNewThreadsAfterChapter: endChapter,
  protagonistEndState: ['主角状态'],
  antagonistEndState: ['对手状态']
})

async function main(): Promise<void> {
  const { closeDatabase, getDatabase, injectDatabaseForTest } = await import('../src/main/db/connection')
  injectDatabaseForTest(new Database(':memory:'))
  const { initSchema, workDAO, volumeChapterDAO } = await import('../src/main/db')
  const {
    invalidateNovelGoalStateAfterVolumeDeletion,
    readNovelGoalState,
    reconcileNovelWorkflowState,
    reopenStalledNovelVolumeGate,
    resetNovelGoalStateFromVolumePlan,
    updateNovelGoalState
  } = await import('../src/main/context/goal-routine/novel-outline-pipeline')
  const { performNovelReplanReset, previewNovelReplanReset } = await import(
    '../src/main/context/goal-routine/novel-replan-reset'
  )
  initSchema()

  try {
    const emptyWorkId = workDAO.create({ title: '删除全部分卷', workType: 'novel' })
    const emptyVolumeId = volumeChapterDAO.createVolume(emptyWorkId, '第一卷')
    updateNovelGoalState(emptyWorkId, {
      novelOutline: { version: 2, targetChapters: 2, volumePlan: [contract('第一卷', 1, 2)] },
      volumePlanChecked: true,
      checkedChapterVolumes: ['第一卷'],
      checkedBodyVolumes: ['第一卷'],
      titleHookApplied: true,
      failure: { phase: 'generate_beats', signature: 'stale', count: 6, message: '旧熔断' }
    })
    assert.equal(volumeChapterDAO.deleteVolume(emptyVolumeId), true)
    invalidateNovelGoalStateAfterVolumeDeletion(emptyWorkId, '第一卷')
    const resetState = readNovelGoalState(emptyWorkId)
    assert.equal(resetState.novelOutline, undefined)
    assert.equal(resetState.volumePlanChecked, undefined)
    assert.equal(resetState.checkedChapterVolumes, undefined)
    assert.equal(resetState.checkedBodyVolumes, undefined)
    assert.equal(resetState.titleHookApplied, undefined)
    assert.equal(resetState.failure, undefined)

    const partialWorkId = workDAO.create({ title: '删除单卷', workType: 'novel' })
    const firstId = volumeChapterDAO.createVolume(partialWorkId, '第一卷')
    volumeChapterDAO.createVolume(partialWorkId, '第二卷')
    updateNovelGoalState(partialWorkId, {
      novelOutline: {
        version: 2,
        targetChapters: 4,
        volumePlan: [contract('第一卷', 1, 2), contract('第二卷', 3, 4)]
      },
      checkedChapterVolumes: ['第一卷', '第二卷'],
      checkedBodyVolumes: ['第一卷', '第二卷'],
      pendingChapterVolumeGate: '第一卷',
      chapterVolumeGateCheckpoint: {
        version: 2,
        volume: '第一卷',
        round: 1,
        snapshotFingerprint: 'x',
        assessments: []
      }
    })
    volumeChapterDAO.deleteVolume(firstId)
    invalidateNovelGoalStateAfterVolumeDeletion(partialWorkId, '第一卷')
    const partialState = readNovelGoalState(partialWorkId)
    assert.deepEqual(partialState.checkedChapterVolumes, ['第二卷'])
    assert.deepEqual(partialState.checkedBodyVolumes, ['第二卷'])
    assert.equal(partialState.pendingChapterVolumeGate, undefined)
    assert.equal(partialState.chapterVolumeGateCheckpoint, undefined)

    const staleWorkId = workDAO.create({ title: '冻结标记自愈', workType: 'novel' })
    volumeChapterDAO.createVolume(staleWorkId, '第一卷')
    updateNovelGoalState(staleWorkId, {
      novelOutline: { version: 2, targetChapters: 2, volumePlan: [contract('第一卷', 1, 2)] },
      volumePlanChecked: true,
      checkedChapterVolumes: ['第一卷'],
      checkedBodyVolumes: ['第一卷'],
      failure: { phase: 'generate_beats', signature: 'stale', count: 6, message: '旧熔断' }
    })
    const reconciled = reconcileNovelWorkflowState(staleWorkId)
    assert.equal(reconciled.changed, true)
    assert.deepEqual(reconciled.invalidatedChapterVolumes, ['第一卷'])
    assert.deepEqual(reconciled.invalidatedBodyVolumes, ['第一卷'])
    assert.deepEqual(readNovelGoalState(staleWorkId).checkedChapterVolumes, [])
    assert.deepEqual(readNovelGoalState(staleWorkId).checkedBodyVolumes, [])
    assert.equal(readNovelGoalState(staleWorkId).failure, undefined)

    updateNovelGoalState(staleWorkId, {
      failure: { phase: 'generate_beats', signature: 'stall', count: 4, message: '超过安全上限' },
      chapterVolumeGateCheckpoint: {
        version: 2,
        repairProtocolVersion: 3,
        volume: '第一卷',
        round: 3,
        snapshotFingerprint: 'snapshot',
        assessments: [{
          key: '1-2', startChapter: 1, endChapter: 2, passed: false, score: 90,
          summary: '旧诊断', issues: []
        }],
        repairControl: {
          changedChapterNumbers: [2],
          rewriteCounts: { '2': 1 },
          lastRoundVersions: [{ chapterId: 2, versionId: 9 }]
        },
        stalled: { reason: '超过安全上限', createTime: '2026-07-22T00:00:00.000Z' }
      }
    })
    assert.equal(reopenStalledNovelVolumeGate(staleWorkId), true)
    const reopened = readNovelGoalState(staleWorkId)
    assert.equal(reopened.failure, undefined)
    assert.equal(reopened.chapterVolumeGateCheckpoint?.stalled, undefined)
    assert.equal(reopened.chapterVolumeGateCheckpoint?.round, 1)
    assert.deepEqual(reopened.chapterVolumeGateCheckpoint?.assessments, [])
    assert.deepEqual(reopened.chapterVolumeGateCheckpoint?.repairControl?.changedChapterNumbers, [2])
    assert.deepEqual(reopened.chapterVolumeGateCheckpoint?.repairControl?.rewriteCounts, { '2': 1 })
    assert.deepEqual(reopened.chapterVolumeGateCheckpoint?.repairControl?.lastRoundVersions, [])

    updateNovelGoalState(staleWorkId, {
      volumeGateDeferredIssues: [{
        volume: '第一卷', score: 92, rounds: 2, reason: '达到安全边界',
        deferredAt: '2026-07-22T00:00:00.000Z', issues: []
      }]
    })

    resetNovelGoalStateFromVolumePlan(staleWorkId)
    assert.equal(readNovelGoalState(staleWorkId).novelOutline, undefined)
    assert.equal(readNovelGoalState(staleWorkId).volumeGateDeferredIssues, undefined)

    const resetWorkId = workDAO.create({ title: '原子重新规划', workType: 'novel' })
    const resetVolumeId = volumeChapterDAO.createVolume(resetWorkId, '旧第一卷')
    const resetChapterId = volumeChapterDAO.createChapter(resetVolumeId, '旧第一章', '旧大纲', 1)
    volumeChapterDAO.updateChapter(resetChapterId, {
      content: '这是必须由备份保留、由当前作品清理的旧正文。',
      word_count: 22,
      status: 'completed'
    })
    const database = getDatabase()
    database.prepare(
      'INSERT INTO chapter_versions (chapter_id, version_number, content, word_count) VALUES (?, 1, ?, 22)'
    ).run(resetChapterId, '旧正文版本')
    database.prepare(
      "INSERT INTO causal_narrative_states (work_id, revision, state_json) VALUES (?, 1, '{}')"
    ).run(resetWorkId)
    database.prepare(
      "INSERT INTO causal_chapter_decisions (chapter_id, work_id, state_revision, status, plan_json) VALUES (?, ?, 1, 'committed', '{}')"
    ).run(resetChapterId, resetWorkId)
    const parentVersionId = Number(database.prepare(`
      INSERT INTO causal_content_versions (
        work_id, chapter_id, body_hash, content, word_count, source, edit_kind, status
      ) VALUES (?, ?, 'parent-hash', '父版本', 3, 'generated', 'generated', 'superseded')
    `).run(resetWorkId, resetChapterId).lastInsertRowid)
    const currentVersionId = Number(database.prepare(`
      INSERT INTO causal_content_versions (
        work_id, chapter_id, parent_version_id, body_hash, content, word_count, source, edit_kind, status
      ) VALUES (?, ?, ?, 'current-hash', '当前版本', 4, 'generated', 'generated', 'active')
    `).run(resetWorkId, resetChapterId, parentVersionId).lastInsertRowid)
    database.prepare(`
      INSERT INTO causal_chapter_bindings (
        chapter_id, work_id, content_version_id, state_before_revision, state_after_revision,
        decision_status, binding_status
      ) VALUES (?, ?, ?, 0, 1, 'committed', 'active')
    `).run(resetChapterId, resetWorkId, currentVersionId)
    database.prepare(`
      INSERT INTO causal_stage_checkpoints (
        work_id, chapter_id, content_version_id, body_hash, protocol_version, stage, status
      ) VALUES (?, ?, ?, 'current-hash', 29, 'causal_outcome', 'completed')
    `).run(resetWorkId, resetChapterId, currentVersionId)
    database.prepare(
      "INSERT INTO resource_constraints (work_id, resource) VALUES (?, '积分')"
    ).run(resetWorkId)
    database.prepare(
      "INSERT INTO core_settings (work_id, type, content) VALUES (?, 'idea', '初始灵感'), (?, 'protagonist', '主角设定')"
    ).run(resetWorkId, resetWorkId)
    updateNovelGoalState(resetWorkId, {
      novelOutline: { version: 2, targetChapters: 1, volumePlan: [contract('旧第一卷', 1, 1)] },
      checkedBodyVolumes: ['旧第一卷']
    })

    const preview = previewNovelReplanReset(resetWorkId)
    assert.equal(preview.volumeCount, 1)
    assert.equal(preview.chapterCount, 1)
    assert.equal(preview.bodyChapterCount, 1)
    assert.equal(preview.authorityDecisionCount, 1)

    performNovelReplanReset(resetWorkId, 'preserve')
    const count = (table: string, workId = resetWorkId): number => (
      database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE work_id = ?`)
        .get(workId) as { count: number }
    ).count
    assert.equal(count('volumes'), 0)
    assert.equal(count('causal_narrative_states'), 0)
    assert.equal(count('causal_chapter_decisions'), 0)
    assert.equal(count('resource_constraints'), 0)
    assert.equal(count('core_settings'), 2)
    const remainingChapterVersions = database.prepare(
      'SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?'
    ).get(resetChapterId) as { count: number }
    assert.equal(remainingChapterVersions.count, 0)
    const resetRun = database.prepare(
      'SELECT status, desired_state, current_phase, turn_count FROM workflow_runs WHERE work_id = ?'
    ).get(resetWorkId) as { status: string; desired_state: string; current_phase: string; turn_count: number }
    assert.deepEqual(resetRun, {
      status: 'idle', desired_state: 'paused', current_phase: 'materialize_settings', turn_count: 0
    })
    assert.equal(readNovelGoalState(resetWorkId).novelOutline, undefined)

    const regenerateWorkId = workDAO.create({ title: '连同设定重置', workType: 'novel' })
    database.prepare(
      "INSERT INTO core_settings (work_id, type, content) VALUES (?, 'idea', '保留灵感'), (?, 'character_cards', '旧角色卡')"
    ).run(regenerateWorkId, regenerateWorkId)
    database.prepare(
      "INSERT INTO anchors (work_id, type, title, content) VALUES (?, 'fact', '旧锚点', '应删除')"
    ).run(regenerateWorkId)
    performNovelReplanReset(regenerateWorkId, 'regenerate')
    const remainingTypes = database.prepare(
      'SELECT type FROM core_settings WHERE work_id = ? ORDER BY type'
    ).all(regenerateWorkId) as Array<{ type: string }>
    assert.deepEqual(remainingTypes.map(item => item.type), ['idea'])
    assert.equal(count('anchors', regenerateWorkId), 0)
  } finally {
    closeDatabase()
  }

  console.log('novel volume state invalidation tests passed')
}

void main()
