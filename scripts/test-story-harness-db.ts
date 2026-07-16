import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { StoryHarnessDAO } from '../src/main/db/dao/story-harness-dao'
import { VolumeChapterDAO } from '../src/main/db/dao/chapter-dao'

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
db.exec(`
  CREATE TABLE works (id INTEGER PRIMARY KEY, title TEXT, description TEXT);
  CREATE TABLE volumes (id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL, name TEXT, sort INTEGER);
  CREATE TABLE chapters (
    id INTEGER PRIMARY KEY, volume_id INTEGER NOT NULL, title TEXT, outline TEXT,
    content TEXT, word_count INTEGER DEFAULT 0, sort INTEGER, status TEXT,
    emotion_intensity INTEGER, beat_role TEXT, foreshadow_target TEXT, next_hook TEXT,
    pov_mode TEXT, characters TEXT, outline_diagnosis TEXT, emotion_contract_json TEXT,
    emotion_assessment_json TEXT, quality_assessment_json TEXT,
    create_time TEXT DEFAULT CURRENT_TIMESTAMP, update_time TEXT
  );
  CREATE TABLE chapter_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chapter_id INTEGER, version_number INTEGER,
    outline TEXT, content TEXT, word_count INTEGER, model_type TEXT, style_id INTEGER,
    generation_round INTEGER, snapshot_json TEXT
  );
  CREATE TABLE emotional_state_ledger (id INTEGER PRIMARY KEY, chapter_id INTEGER);
  CREATE TABLE story_generation_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, work_id INTEGER NOT NULL, chapter_id INTEGER NOT NULL,
    base_content_hash TEXT, content TEXT NOT NULL, word_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'generated', source_step TEXT NOT NULL DEFAULT 'body_generation',
    attempt_no INTEGER NOT NULL DEFAULT 1, checks_json TEXT, reject_reason TEXT,
    create_time TEXT DEFAULT CURRENT_TIMESTAMP, update_time TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE story_issue_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, work_id INTEGER NOT NULL, issue_key TEXT NOT NULL,
    code TEXT NOT NULL, severity TEXT NOT NULL, scope TEXT NOT NULL,
    chapter_ids_json TEXT, evidence_json TEXT, invariants_json TEXT, expected_result TEXT,
    message TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
    first_seen_time TEXT DEFAULT CURRENT_TIMESTAMP, last_seen_time TEXT DEFAULT CURRENT_TIMESTAMP,
    resolved_time TEXT, UNIQUE(work_id, issue_key)
  );
  CREATE TABLE story_release_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, work_id INTEGER NOT NULL, label TEXT NOT NULL,
    content_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, is_frozen INTEGER NOT NULL DEFAULT 1,
    create_time TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO works VALUES (1, '测试故事', '');
  INSERT INTO volumes VALUES (1, 1, '正文', 1);
  INSERT INTO chapters (
    id, volume_id, title, outline, content, word_count, sort, status,
    emotion_assessment_json, quality_assessment_json, update_time
  ) VALUES (1, 1, '第一拍', '大纲', '不可丢失的正式正文', 9, 1, 'completed', NULL, NULL, CURRENT_TIMESTAMP);
`)

const dao = new StoryHarnessDAO(db)
const rejectedId = dao.createCandidate({
  workId: 1,
  chapterId: 1,
  content: '门禁失败的候选正文',
  wordCount: 9,
  baseContent: '不可丢失的正式正文'
})
dao.markCandidate(rejectedId, 'rejected', { rejectReason: '注入的门禁失败' })
assert.equal(db.prepare('SELECT content FROM chapters WHERE id = 1').get().content, '不可丢失的正式正文')
assert.equal(dao.countCandidatesForBaseline(1, 1, '不可丢失的正式正文'), 1)
assert.equal(dao.listCandidatesForBaseline(1, 1, '不可丢失的正式正文')[0].reject_reason, '注入的门禁失败')
assert.equal(dao.countCandidatesForBaseline(1, 1, '正文相同但结构版本已变化'), 0)

const acceptedId = dao.createCandidate({
  workId: 1,
  chapterId: 1,
  content: '通过全部门禁的新正文',
  wordCount: 10,
  baseContent: '不可丢失的正式正文'
})
assert.equal(dao.acceptCandidate(acceptedId), true)
assert.equal(db.prepare('SELECT content FROM chapters WHERE id = 1').get().content, '通过全部门禁的新正文')
assert.equal(db.prepare('SELECT content FROM chapter_versions WHERE chapter_id = 1').get().content, '不可丢失的正式正文')
assert.equal(dao.getCandidate(acceptedId)?.status, 'accepted')
assert.throws(() => dao.createCandidate({ workId: 1, chapterId: 1, content: '  ', wordCount: 0 }))

const issue = {
  code: 'FINAL_NEW_ARC',
  severity: 'blocker' as const,
  scope: 'beat' as const,
  chapterIds: [1],
  evidence: ['下一个任务'],
  message: '结尾开启新主线',
  expectedResult: '删除续集任务'
}
dao.syncIssues(1, [issue])
const key = dao.listIssues(1, 'open')[0].issue_key
dao.incrementIssueAttempt(1, key, 2)
dao.incrementIssueAttempt(1, key, 2)
dao.syncIssues(1, [issue])
assert.equal(dao.listIssues(1)[0].status, 'stalled')
dao.syncIssues(1, [])
assert.equal(dao.listIssues(1)[0].status, 'resolved')

const snapshotId = dao.createReleaseSnapshot(1)
assert.ok(snapshotId > 0)
assert.equal(db.prepare('SELECT is_frozen FROM story_release_snapshots WHERE id = ?').get(snapshotId).is_frozen, 1)

const chapterDAO = new VolumeChapterDAO(db)
chapterDAO.rewriteStoryBeatsPreservingVersions([{
  chapterId: 1,
  title: '重建后的第一拍',
  outline: '全新结构',
  beat_role: 'A',
  outline_diagnosis: JSON.stringify({ continuity_contract: { end_location: '三楼' } })
}])
const rewritten = db.prepare('SELECT title, outline, content, word_count FROM chapters WHERE id = 1').get() as Record<string, unknown>
assert.equal(rewritten.title, '重建后的第一拍')
assert.equal(rewritten.outline, '全新结构')
assert.equal(rewritten.content, '')
assert.equal(rewritten.word_count, 0)
assert.ok((db.prepare('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id = 1').get() as { n: number }).n >= 2)

const outlineBeforeAtomicFailure = (db.prepare('SELECT outline FROM chapters WHERE id = 1').get() as { outline: string }).outline
const versionsBeforeAtomicFailure = (db.prepare('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id = 1').get() as { n: number }).n
assert.throws(() => chapterDAO.updateChaptersWithVersionsAtomic([
  { chapterId: 1, fields: { outline: '不应提交的半批补丁' } },
  { chapterId: 999, fields: { outline: '不存在的章节' } }
]), /章节不存在|章节原子更新失败/)
assert.equal((db.prepare('SELECT outline FROM chapters WHERE id = 1').get() as { outline: string }).outline, outlineBeforeAtomicFailure)
assert.equal(
  (db.prepare('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id = 1').get() as { n: number }).n,
  versionsBeforeAtomicFailure
)

db.prepare(`UPDATE chapters SET
  title = '回滚前标题', outline = '回滚前大纲', next_hook = '回滚前钩子',
  characters = '["陈凉"]', outline_diagnosis = '{"dramatic_contract":{"turn":"回滚前转折"}}'
  WHERE id = 1`).run()
const repairSnapshots = chapterDAO.updateChaptersWithVersionsAtomic([{
  chapterId: 1,
  fields: {
    title: '修复后标题',
    outline: '修复后大纲',
    next_hook: '修复后钩子',
    characters: '["陈凉","小满"]',
    outline_diagnosis: '{"dramatic_contract":{"turn":"修复后转折"}}'
  }
}])
assert.equal(repairSnapshots.length, 1)
assert.ok((db.prepare('SELECT snapshot_json FROM chapter_versions WHERE id = ?').get(
  repairSnapshots[0].versionId
) as { snapshot_json: string }).snapshot_json.includes('回滚前钩子'))
chapterDAO.restoreVersionsAtomic(repairSnapshots)
const restored = db.prepare(
  'SELECT title, outline, next_hook, characters, outline_diagnosis FROM chapters WHERE id = 1'
).get() as Record<string, string>
assert.equal(restored.title, '回滚前标题')
assert.equal(restored.outline, '回滚前大纲')
assert.equal(restored.next_hook, '回滚前钩子')
assert.equal(restored.characters, '["陈凉"]')
assert.equal(restored.outline_diagnosis, '{"dramatic_contract":{"turn":"回滚前转折"}}')

db.close()
console.log('story harness database failure-injection tests passed')
