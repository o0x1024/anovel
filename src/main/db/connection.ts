import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import { ensureIncrementalMigrations } from './migrations'

let db: Database.Database | null = null
let migrationsApplied = false

/** 仅供 ELECTRON_RUN_AS_NODE 故障注入测试使用，生产进程禁止替换数据库单例。 */
export function injectDatabaseForTest(database: Database.Database): void {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
    throw new Error('injectDatabaseForTest 只能在 ELECTRON_RUN_AS_NODE 测试进程中使用')
  }
  if (db && db !== database) db.close()
  db = database
  migrationsApplied = false
}

/**
 * 获取数据库实例（单例）
 * 数据库文件存储在用户数据目录
 */
export function getDatabase(): Database.Database {
  if (!db) {
    const dbPath = path.join(app.getPath('userData'), 'anovel.db')
    db = new Database(dbPath)

    // 开启 WAL 模式提升并发性能
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }

  if (!migrationsApplied) {
    ensureIncrementalMigrations(db)
    migrationsApplied = true
  }
  return db
}

/**
 * 关闭数据库连接
 */
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    migrationsApplied = false
  }
}
