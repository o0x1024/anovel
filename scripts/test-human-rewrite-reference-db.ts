import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ensureIncrementalMigrations } from '../src/main/db/migrations'
import { HumanRewriteReferenceDAO } from '../src/main/db/dao/human-rewrite-reference-dao'

const db = new Database(':memory:')
ensureIncrementalMigrations(db)

const table = db.prepare(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'aigc_rewrite_examples'`
).get() as { name: string } | undefined
assert.equal(table?.name, 'aigc_rewrite_examples', '增量迁移必须创建案例表')

const dao = new HumanRewriteReferenceDAO(db)
const created = dao.create({
  title: ' 对话镜头链 ',
  sceneTypes: ['dialogue'],
  aiSymptoms: ['shot_chain'],
  originalText: ' 他眼中闪过一丝惊讶，缓缓开口。 ',
  rewrittenText: ' “你早知道？”他把杯子推了回去。 ',
  rewritePrinciples: [' 删除镜头链 '],
  preservedFacts: ['台词意图不变'],
  forbiddenChanges: ['不增加人物'],
  priority: 120
})

assert.equal(created.title, '对话镜头链')
assert.equal(created.priority, 100, '优先级必须限制在 0-100')
assert.deepEqual(created.sceneTypes, ['dialogue'])
assert.equal(dao.listEnabled().length, 1)

assert.equal(dao.toggleEnabled(created.id, false), true)
assert.equal(dao.listEnabled().length, 0)
assert.equal(dao.update(created.id, {
  ...created,
  title: '对话中的镜头链',
  enabled: true,
  rewritePrinciples: ['删除无意义微动作', '保留言外之意']
}), true)
assert.equal(dao.getById(created.id)?.rewritePrinciples.length, 2)

assert.throws(() => dao.create({
  title: '无效案例',
  sceneTypes: [],
  aiSymptoms: ['shot_chain'],
  originalText: '原文',
  rewrittenText: '改文',
  rewritePrinciples: ['原则'],
  preservedFacts: [],
  forbiddenChanges: []
}), /请选择 1-2 个有效场景类型/)

assert.equal(dao.delete(created.id), true)
assert.equal(dao.list().length, 0)

db.close()
console.log('人工化改写案例数据库迁移与 CRUD 测试通过')
