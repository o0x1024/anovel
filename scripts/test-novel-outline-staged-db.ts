import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

async function main(): Promise<void> {
  const { closeDatabase, getDatabase, injectDatabaseForTest } = await import('../src/main/db/connection')
  injectDatabaseForTest(new Database(':memory:'))
  const { initSchema, novelOutlineDAO, workDAO, volumeChapterDAO } = await import('../src/main/db')
  initSchema()
  try {
    const workId = workDAO.create({ title: '分阶段章节合同测试', workType: 'novel' })
    const ids = novelOutlineDAO.commitBatch({
      workId,
      volumeName: '第一卷',
      volumeDescription: '测试卷',
      volumeSort: 1,
      volumeStartChapter: 1,
      volumeEndChapter: 3,
      chapterStartSort: 1,
      items: [{
        title: '第一章',
        outline: '【开场状态】院门外。【必须覆盖】主角进门。【禁止越界】不得揭露真凶。【结尾落点】门内传来脚步。【连续性约束】承接上一刻。',
        arcPhase: 'setup',
        payoffRole: 'B',
        foreshadowTarget: null,
        nextHook: '门内是谁',
        characters: ['主角'],
        outlineDiagnosis: JSON.stringify({
          arc_phase: 'setup',
          dramatic_contract: { stakes: '失去唯一线索' },
          pattern_contract: { antagonist_tactic: '诱导主角进入院内' },
          tension_plan: { level: 6, payoff_type: 'debt' }
        }),
        emotionContract: null,
        resourceBudgets: []
      }]
    })
    assert.equal(ids.length, 1)
    const chapter = volumeChapterDAO.getChapter(ids[0])
    assert.equal(chapter?.emotion_contract_json, null)
    assert.match(chapter?.outline_diagnosis ?? '', /antagonist_tactic/)
    assert.doesNotMatch(chapter?.outline_diagnosis ?? '', /emotion_contract/)
    const row = getDatabase().prepare(
      'SELECT COUNT(*) AS n FROM chapter_resource_budgets WHERE chapter_id = ?'
    ).get(ids[0]) as { n: number }
    assert.equal(row.n, 0)
    process.stdout.write('novel staged outline database tests passed\n')
  } finally {
    closeDatabase()
  }
}

void main()
