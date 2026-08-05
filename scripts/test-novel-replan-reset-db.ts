import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

async function main(): Promise<void> {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'anovel-replan-reset-'))
  process.env.ANOVEL_TEST_BACKUP_DIR = temporaryRoot

  const { closeDatabase, getDatabase, injectDatabaseForTest } = await import('../src/main/db/connection')
  injectDatabaseForTest(new Database(':memory:'))
  const { initSchema, coreSettingDAO, volumeChapterDAO, workDAO } = await import('../src/main/db')
  const { restartNovelPlanning } = await import('../src/main/context/goal-routine/novel-replan-reset')
  initSchema()

  try {
    const workId = workDAO.create({ title: '安全重新规划', workType: 'novel' })
    coreSettingDAO.upsert(workId, 'idea', '保留的初始灵感')
    coreSettingDAO.upsert(workId, 'protagonist', '保留的主角设定')
    const volumeId = volumeChapterDAO.createVolume(workId, '旧第一卷')
    const chapterId = volumeChapterDAO.createChapter(volumeId, '旧第一章', '旧章节大纲', 1)
    volumeChapterDAO.updateChapter(chapterId, {
      content: '这段正文必须同时进入数据库备份和作品 JSON 备份。',
      word_count: 25,
      status: 'completed'
    })

    await assert.rejects(
      restartNovelPlanning({
        workId,
        confirmationTitle: '错误书名',
        settingsMode: 'preserve'
      }),
      /作品名确认不匹配/
    )
    assert.equal(volumeChapterDAO.listVolumes(workId).length, 1)

    const result = await restartNovelPlanning({
      workId,
      confirmationTitle: '安全重新规划',
      settingsMode: 'preserve'
    })
    assert.equal(existsSync(result.databaseBackupPath), true)
    assert.equal(existsSync(result.workBackupPath), true)
    const bundle = JSON.parse(readFileSync(result.workBackupPath, 'utf8')) as {
      volumes: Array<{ chapters: Array<{ content: string }> }>
    }
    assert.equal(bundle.volumes[0]?.chapters[0]?.content.includes('必须同时进入'), true)

    const backup = new Database(result.databaseBackupPath, { readonly: true })
    try {
      assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok')
      const backedUpBodies = backup.prepare(`
        SELECT COUNT(*) AS count
        FROM chapters c JOIN volumes v ON v.id = c.volume_id
        WHERE v.work_id = ? AND TRIM(COALESCE(c.content, '')) <> ''
      `).get(workId) as { count: number }
      assert.equal(backedUpBodies.count, 1)
    } finally {
      backup.close()
    }

    assert.equal(volumeChapterDAO.listVolumes(workId).length, 0)
    assert.equal(volumeChapterDAO.listChaptersByWork(workId).length, 0)
    assert.equal(coreSettingDAO.getByType(workId, 'protagonist')?.content, '保留的主角设定')
    const run = getDatabase().prepare(
      'SELECT status, desired_state, current_phase FROM workflow_runs WHERE work_id = ?'
    ).get(workId) as { status: string; desired_state: string; current_phase: string }
    assert.deepEqual(run, {
      status: 'idle', desired_state: 'paused', current_phase: 'materialize_settings'
    })
  } finally {
    closeDatabase()
    delete process.env.ANOVEL_TEST_BACKUP_DIR
    rmSync(temporaryRoot, { recursive: true, force: true })
  }

  console.log('novel replan reset backup and transaction tests passed')
}

void main()
