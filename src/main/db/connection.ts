import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import { ensureIncrementalMigrations } from './migrations'

let db: Database.Database | null = null

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

  ensureIncrementalMigrations(db)
  return db
}

/**
 * 关闭数据库连接
 */
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
