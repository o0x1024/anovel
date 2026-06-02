import Database from 'better-sqlite3'
import { getDatabase } from '../connection'

/**
 * 基础 DAO 类，提供通用的数据库操作
 */
export abstract class BaseDAO {
  protected get db(): Database.Database {
    return getDatabase()
  }

  /**
   * 执行查询并返回所有行
   */
  protected all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params ?? [])) as T[]
  }

  /**
   * 执行查询并返回第一行
   */
  protected get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params ?? [])) as T | undefined
  }

  /**
   * 执行写操作并返回变化行数
   */
  protected run(sql: string, params?: unknown[]): Database.RunResult {
    return this.db.prepare(sql).run(...(params ?? []))
  }

  /**
   * 执行插入操作并返回 lastInsertRowid
   */
  protected insert(sql: string, params?: unknown[]): number {
    const result = this.db.prepare(sql).run(...(params ?? []))
    return Number(result.lastInsertRowid)
  }

  /**
   * 在事务中执行多个操作
   */
  protected transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn)
    return tx()
  }
}
