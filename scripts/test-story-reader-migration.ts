import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { injectDatabaseForTest } from '../src/main/db/connection'
import { initSchema } from '../src/main/db/schema'

const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
injectDatabaseForTest(db)
initSchema()

const columns = db.prepare('PRAGMA table_info(story_reader_feedback)').all() as Array<{ name: string }>
assert.ok(columns.some(column => column.name === 'release_snapshot_id'))
assert.ok(columns.some(column => column.name === 'preview_completions'))
assert.ok(columns.some(column => column.name === 'avg_read_seconds'))
assert.equal(
  (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_story_reader_feedback_work'").get() as { n: number }).n,
  1
)

db.close()
console.log('story reader feedback migration tests passed')
