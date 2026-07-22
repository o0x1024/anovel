import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

function volumeFingerprint(chapters: unknown[]): string {
  const hash = createHash('sha256')
  for (const item of chapters) {
    const chapter = item as Record<string, unknown>
    hash.update(JSON.stringify({
      id: chapter.id,
      update_time: chapter.update_time,
      title: chapter.title,
      outline: chapter.outline,
      beat_role: chapter.beat_role,
      foreshadow_target: chapter.foreshadow_target,
      next_hook: chapter.next_hook,
      characters: chapter.characters,
      outline_diagnosis: chapter.outline_diagnosis,
      emotion_contract_json: chapter.emotion_contract_json
    }))
  }
  return hash.digest('hex')
}

async function main(): Promise<void> {
  const { closeDatabase, injectDatabaseForTest } = await import('../src/main/db/connection')
  injectDatabaseForTest(new Database(':memory:'))
  const { initSchema, resourceLedgerDAO, volumeChapterDAO, workDAO } = await import('../src/main/db')
  const { getChapterPlanningDetails } = await import('../src/main/context/chapter-planning-details')
  const { updateNovelGoalState } = await import('../src/main/context/goal-routine/novel-outline-pipeline')
  initSchema()

  try {
    const workId = workDAO.create({ title: '章节规划展示', workType: 'novel' })
    const volumeId = volumeChapterDAO.createVolume(workId, '第一卷')
    const chapterId = volumeChapterDAO.createChapter(
      volumeId,
      '第1章 起点',
      [
        '【开场状态】林舟站在封锁线外。',
        '【必须覆盖】林舟找到通行证；守卫识破旧印章。',
        '【禁止越界】不得提前揭示内鬼身份。',
        '【结尾落点】门内传来熟悉的咳嗽声。',
        '【连续性约束】紧接上一场封锁升级。'
      ].join('\n')
    )
    volumeChapterDAO.updateChapter(chapterId, {
      outline_diagnosis: JSON.stringify({
        dramatic_contract: {
          scene_promise: '主角第一次突破封锁',
          protagonist_want: '进入封锁区',
          obstacle: '守卫核验身份',
          stakes: '母亲失去救治窗口',
          turn: '旧印章被识破',
          irreversible_change: '主角进入追查名单',
          next_question: '门内的人是谁'
        },
        pattern_contract: { conflict_type: '规则对抗' },
        tension_plan: { level: 'high', payoff_type: 'partial' }
      }),
      emotion_contract_json: JSON.stringify({ trigger: '听见咳嗽声', choice: '继续闯入', cost: '身份暴露' })
    })
    resourceLedgerDAO.replaceBudgetsForChapter(workId, chapterId, [{
      owner: '林舟', resource: '通行证可信度', unit: '级', start_min: 2, start_max: 2,
      end_min: 0, end_max: 1, forbidden_events: '不得恢复为可信', reason: '印章已被识破'
    }])
    updateNovelGoalState(workId, { checkedChapterVolumes: ['第一卷'] })

    const legacy = getChapterPlanningDetails(workId, chapterId)
    assert.equal(legacy.executionContract?.openingState, '林舟站在封锁线外。')
    assert.deepEqual(legacy.executionContract?.requiredEvents, ['林舟找到通行证', '守卫识破旧印章'])
    assert.equal(legacy.structureContract?.dramatic_contract != null, true)
    assert.equal(legacy.emotionContract?.choice, '继续闯入')
    assert.equal(legacy.resourceBudgets.length, 1)
    assert.equal(legacy.gate.status, 'passed')
    assert.equal(legacy.gate.historicalScoreMissing, true)

    updateNovelGoalState(workId, {
      checkedChapterVolumes: ['第一卷'],
      chapterVolumeGateResults: [{
        volume: '第一卷', status: 'passed', score: 94, rounds: 2,
        completedAt: '2026-07-22T08:00:00.000Z',
        snapshotFingerprint: volumeFingerprint(volumeChapterDAO.listChapters(volumeId)),
        issues: []
      }]
    })
    const persisted = getChapterPlanningDetails(workId, chapterId)
    assert.equal(persisted.gate.status, 'passed')
    assert.equal(persisted.gate.score, 94)
    assert.equal(persisted.gate.historicalScoreMissing, undefined)

    volumeChapterDAO.updateChapter(chapterId, { next_hook: '大纲变更后的新钩子' })
    const stale = getChapterPlanningDetails(workId, chapterId)
    assert.equal(stale.gate.status, 'not_run')
    assert.match(stale.gate.reason ?? '', /上次门禁后已变更/)

    updateNovelGoalState(workId, {
      checkedChapterVolumes: [],
      chapterVolumeGateCheckpoint: {
        version: 2,
        volume: '第一卷',
        round: 2,
        snapshotFingerprint: 'test',
        assessments: [{
          key: '1-1', startChapter: 1, endChapter: 1, passed: false, score: 82,
          summary: '仍有越界风险',
          issues: [{
            source: 'model', code: 'EARLY_REVEAL', problem: '提前暗示内鬼',
            repairChapterNumbers: [1], evidence: [{ chapterNumber: 1, quote: '内鬼' }],
            requiredFix: '删除提前暗示'
          }]
        }]
      }
    })
    const running = getChapterPlanningDetails(workId, chapterId)
    assert.equal(running.gate.status, 'running')
    assert.equal(running.gate.score, 82)
    assert.equal(running.gate.issues[0]?.appliesToChapter, true)
    assert.equal(running.gate.issues[0]?.requiredFix, '删除提前暗示')

    volumeChapterDAO.updateChapter(chapterId, { emotion_contract_json: '{broken' })
    const malformed = getChapterPlanningDetails(workId, chapterId)
    assert.match(malformed.warnings.join('；'), /情绪合同不是合法 JSON/)

    console.log('chapter planning details tests passed')
  } finally {
    closeDatabase()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
