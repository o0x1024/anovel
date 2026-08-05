import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  NarrativeKernelError,
  sha256,
  type EvidenceSpan,
  type NarrativeCommit,
  type NarrativeEvent
} from '../src/main/narrative-kernel'
import { NarrativeEventStore } from '../src/main/narrative-kernel/storage/event-store'

const db = new Database(':memory:')
const store = new NarrativeEventStore(db)

function evidence(chapterVersionId: string, content: string, quote: string): EvidenceSpan {
  const startOffset = content.indexOf(quote)
  assert.notEqual(startOffset, -1)
  return {
    chapterVersionId,
    startOffset,
    endOffset: startOffset + quote.length,
    quoteHash: sha256(quote)
  }
}

function expectCode(code: NarrativeKernelError['code'], run: () => unknown): void {
  assert.throws(run, error => {
    assert.ok(error instanceof NarrativeKernelError)
    assert.equal(error.code, code)
    return true
  })
}

const chapter1Content = '陈凉继承了父亲的徽章。老周守在避难所门口。'
const chapter1Events: NarrativeEvent[] = [
  {
    id: 'event-v2-chenliang',
    type: 'ActorIntroduced',
    chapterOrdinal: 1,
    actorId: 'actor-chenliang',
    canonicalName: '陈凉',
    aliases: [],
    evidence: evidence('chapter-v2-1', chapter1Content, '陈凉')
  },
  {
    id: 'event-v2-laozhou',
    type: 'ActorIntroduced',
    chapterOrdinal: 1,
    actorId: 'actor-laozhou',
    canonicalName: '老周',
    aliases: [],
    evidence: evidence('chapter-v2-1', chapter1Content, '老周')
  },
  {
    id: 'event-v2-father',
    type: 'ActorIntroduced',
    chapterOrdinal: 1,
    actorId: 'actor-father',
    canonicalName: '陈凉的父亲',
    aliases: ['父亲'],
    evidence: evidence('chapter-v2-1', chapter1Content, '父亲')
  },
  {
    id: 'event-v2-shelter',
    type: 'LocationIntroduced',
    chapterOrdinal: 1,
    locationId: 'location-shelter',
    canonicalName: '避难所',
    aliases: [],
    evidence: evidence('chapter-v2-1', chapter1Content, '避难所')
  },
  {
    id: 'event-v2-badge',
    type: 'ArtifactIntroduced',
    chapterOrdinal: 1,
    artifactId: 'artifact-badge',
    canonicalName: '父亲的徽章',
    aliases: ['徽章'],
    provenance: { kind: 'inherited', sourceEntityId: 'actor-father' },
    holder: { kind: 'actor', actorId: 'actor-chenliang' },
    quantity: 1,
    evidence: evidence('chapter-v2-1', chapter1Content, '继承了父亲的徽章')
  }
]
const chapter1: NarrativeCommit = {
  id: 'commit-v2-1',
  workId: 49,
  chapterVersionId: 'chapter-v2-1',
  chapterOrdinal: 1,
  baseRevision: 0,
  revision: 1,
  events: chapter1Events
}

const chapter2Content = '陈凉把徽章交给老周，自己不再持有。'
const chapter2: NarrativeCommit = {
  id: 'commit-v2-2',
  workId: 49,
  chapterVersionId: 'chapter-v2-2',
  chapterOrdinal: 2,
  baseRevision: 1,
  revision: 2,
  events: [{
    id: 'event-v2-badge-transfer',
    type: 'ArtifactTransferred',
    chapterOrdinal: 2,
    artifactId: 'artifact-badge',
    from: { kind: 'actor', actorId: 'actor-chenliang' },
    to: { kind: 'actor', actorId: 'actor-laozhou' },
    evidence: evidence('chapter-v2-2', chapter2Content, '陈凉把徽章交给老周')
  }]
}

try {
  store.createNovel({ id: 49, title: 'V2 事件流测试' })
  assert.equal(store.schemaVersion(), 6)

  const state1 = store.appendChapterCommit({ commit: chapter1, content: chapter1Content })
  assert.equal(state1.revision, 1)

  const state2 = store.appendChapterCommit({ commit: chapter2, content: chapter2Content })
  assert.equal(state2.revision, 2)
  assert.deepEqual(
    state2.artifacts['artifact-badge'].holder,
    { kind: 'actor', actorId: 'actor-laozhou' }
  )

  const reloaded = store.loadState(49)
  assert.deepEqual(reloaded, state2, '数据库事件重放必须恢复完全相同的状态')

  const chapter3Content = '陈凉又从口袋里拿出徽章。'
  const illegalCommit: NarrativeCommit = {
    id: 'commit-v2-3-illegal',
    workId: 49,
    chapterVersionId: 'chapter-v2-3',
    chapterOrdinal: 3,
    baseRevision: 2,
    revision: 3,
    events: [{
      id: 'event-v2-illegal-use',
      type: 'ArtifactUsed',
      chapterOrdinal: 3,
      artifactId: 'artifact-badge',
      actorId: 'actor-chenliang',
      action: '从口袋里拿出徽章',
      evidence: evidence('chapter-v2-3', chapter3Content, '陈凉又从口袋里拿出徽章')
    }]
  }
  expectCode(
    'ARTIFACT_NOT_OWNED',
    () => store.appendChapterCommit({ commit: illegalCommit, content: chapter3Content })
  )

  assert.equal(store.loadState(49).revision, 2, '失败提交不得推进数据库事件流')
  assert.equal(
    (db.prepare(
      "SELECT COUNT(*) AS count FROM narrative_chapter_versions WHERE id = 'chapter-v2-3'"
    ).get() as { count: number }).count,
    0,
    '失败提交不得留下半成品章节版本'
  )

  db.prepare(`
    UPDATE narrative_chapter_versions
    SET content = '被静默篡改的正文'
    WHERE id = 'chapter-v2-1'
  `).run()
  expectCode('CONTENT_HASH_MISMATCH', () => store.loadState(49))
  db.prepare(`
    UPDATE narrative_chapter_versions
    SET content = ?
    WHERE id = 'chapter-v2-1'
  `).run(chapter1Content)
  assert.equal(store.loadState(49).stateHash, state2.stateHash)

  assert.deepEqual(store.integrityCheck(), [])
} finally {
  db.close()
}

const staleSchemaDb = new Database(':memory:')
try {
  staleSchemaDb.exec(`
    CREATE TABLE narrative_kernel_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO narrative_kernel_meta (key, value) VALUES ('schema_version', '2');
  `)
  assert.throws(
    () => new NarrativeEventStore(staleSchemaDb),
    /NARRATIVE_EVENT_STORE_SCHEMA_VERSION_MISMATCH:2/
  )
  assert.equal(
    (staleSchemaDb.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'narrative_novels'
    `).get() as { count: number }).count,
    0,
    'Schema 版本不匹配时必须在创建业务表之前失败'
  )
} finally {
  staleSchemaDb.close()
}

const v5SchemaDb = new Database(':memory:')
try {
  v5SchemaDb.exec(`
    CREATE TABLE narrative_kernel_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO narrative_kernel_meta (key, value) VALUES ('schema_version', '5');
  `)
  const migrated = new NarrativeEventStore(v5SchemaDb)
  assert.equal(migrated.schemaVersion(), 6)
  assert.equal(
    (v5SchemaDb.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'narrative_auto_novel_runs'
    `).get() as { count: number }).count,
    1,
    'V5 V2 数据库必须迁移出自动全书运行表'
  )
} finally {
  v5SchemaDb.close()
}

console.log('narrative-event-store-v2 tests passed')
