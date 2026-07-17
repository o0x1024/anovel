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
  const { closeDatabase, injectDatabaseForTest } = await import('../src/main/db/connection')
  injectDatabaseForTest(new Database(':memory:'))
  const { initSchema, workDAO, volumeChapterDAO } = await import('../src/main/db')
  const {
    invalidateNovelGoalStateAfterVolumeDeletion,
    readNovelGoalState,
    reconcileNovelWorkflowState,
    resetNovelGoalStateFromVolumePlan,
    updateNovelGoalState
  } = await import('../src/main/context/goal-routine/novel-outline-pipeline')
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

    resetNovelGoalStateFromVolumePlan(staleWorkId)
    assert.equal(readNovelGoalState(staleWorkId).novelOutline, undefined)
  } finally {
    closeDatabase()
  }

  console.log('novel volume state invalidation tests passed')
}

void main()
