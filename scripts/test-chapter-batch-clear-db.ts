import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

async function main(): Promise<void> {
  const { closeDatabase, injectDatabaseForTest } = await import('../src/main/db/connection')
  injectDatabaseForTest(new Database(':memory:'))
  const { initSchema, volumeChapterDAO, workDAO } = await import('../src/main/db')
  initSchema()

  try {
    const workId = workDAO.create({ title: '分卷正文批量清空测试', workType: 'novel' })
    const firstVolumeId = volumeChapterDAO.createVolume(workId, '第一卷')
    const secondVolumeId = volumeChapterDAO.createVolume(workId, '第二卷')
    const firstId = volumeChapterDAO.createChapter(firstVolumeId, '第一章', '第一章大纲')
    const secondId = volumeChapterDAO.createChapter(firstVolumeId, '第二章', '第二章大纲')
    const untouchedId = volumeChapterDAO.createChapter(secondVolumeId, '第三章', '第三章大纲')

    volumeChapterDAO.updateChapter(firstId, {
      content: '第一章原正文', word_count: 7, status: 'completed',
      emotion_assessment_json: '{"passed":true}', quality_assessment_json: '{"score":90}'
    })
    volumeChapterDAO.updateChapter(untouchedId, {
      content: '第二卷正文', word_count: 5, status: 'completed'
    })

    const result = volumeChapterDAO.clearVolumeBodiesWithVersions(firstVolumeId)
    assert.deepEqual(result.chapterIds, [firstId, secondId])
    assert.equal(result.clearedCount, 1)
    assert.equal(result.versionedCount, 1)

    const first = volumeChapterDAO.getChapter(firstId)
    assert.equal(first?.content, '')
    assert.equal(first?.word_count, 0)
    assert.equal(first?.status, 'draft')
    assert.equal(first?.outline, '第一章大纲')
    assert.equal(first?.emotion_assessment_json, null)
    assert.equal(first?.quality_assessment_json, null)

    const second = volumeChapterDAO.getChapter(secondId)
    assert.equal(second?.content, '')
    assert.equal(second?.outline, '第二章大纲')
    assert.equal(second?.status, 'draft')
    assert.equal(volumeChapterDAO.listVersions(secondId).length, 0)

    const versions = volumeChapterDAO.listVersions(firstId)
    assert.equal(versions.length, 1)
    assert.equal(versions[0]?.content, '第一章原正文')
    assert.equal(versions[0]?.model_type, 'manual_batch_clear')

    const untouched = volumeChapterDAO.getChapter(untouchedId)
    assert.equal(untouched?.content, '第二卷正文')
    assert.equal(untouched?.status, 'completed')
    assert.equal(volumeChapterDAO.listVersions(untouchedId).length, 0)
  } finally {
    closeDatabase()
  }

  console.log('chapter volume body batch clear tests passed')
}

void main()
