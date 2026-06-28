import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { formatLocalDateTime, localDateString } from '../../shared/local-datetime'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

export interface LogFileInfo {
  name: string
  path: string
  size: number
  mtime: string
}

function ensureLogDir(): string {
  const dir = app.isReady()
    ? app.isPackaged
      ? path.join(app.getPath('userData'), 'logs')
      : path.join(process.cwd(), 'logs')
    : path.join(os.tmpdir(), 'anovel-logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function todayFileName(): string {
  return `anovel-${localDateString()}.log`
}

function todayLlmFileName(): string {
  return `anovel-llm-${localDateString()}.log`
}

function isLlmCategory(category: string): boolean {
  return category === 'llm' || category === 'model'
}

function resolveLogFileName(category: string): string {
  return isLlmCategory(category) ? todayLlmFileName() : todayFileName()
}

function formatLine(
  level: LogLevel,
  category: string,
  message: string,
  meta?: Record<string, unknown>
): string {
  const ts = formatLocalDateTime()
  const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
  return `[${ts}] [${level}] [${category}] ${message}${metaStr}\n`
}

function write(level: LogLevel, category: string, message: string, meta?: Record<string, unknown>): void {
  try {
    const line = formatLine(level, category, message, meta)
    fs.appendFileSync(path.join(ensureLogDir(), resolveLogFileName(category)), line, 'utf8')
    const prefix = `[${category}] ${message}`
    if (level === 'ERROR') console.error(prefix, meta ?? '')
    else if (level === 'WARN') console.warn(prefix, meta ?? '')
    else console.log(prefix, meta ?? '')
  } catch (err) {
    console.error('[AppLogger] 写入日志失败', err)
  }
}

export const appLogger = {
  info(category: string, message: string, meta?: Record<string, unknown>): void {
    write('INFO', category, message, meta)
  },

  warn(category: string, message: string, meta?: Record<string, unknown>): void {
    write('WARN', category, message, meta)
  },

  error(category: string, message: string, meta?: Record<string, unknown>): void {
    write('ERROR', category, message, meta)
  },

  debug(category: string, message: string, meta?: Record<string, unknown>): void {
    write('DEBUG', category, message, meta)
  },

  getLogDir(): string {
    return ensureLogDir()
  },

  getTodayLogPath(): string {
    return path.join(ensureLogDir(), todayFileName())
  },

  getTodayLlmLogPath(): string {
    return path.join(ensureLogDir(), todayLlmFileName())
  },

  readRecentLines(limit = 120): string[] {
    const mainPath = this.getTodayLogPath()
    const llmPath = this.getTodayLlmLogPath()
    const lines: string[] = []
    for (const filePath of [mainPath, llmPath]) {
      if (!fs.existsSync(filePath)) continue
      lines.push(...fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean))
    }
    lines.sort()
    return lines.slice(-Math.max(1, limit))
  },

  readRecentLlmLines(limit = 120): string[] {
    const filePath = this.getTodayLlmLogPath()
    if (!fs.existsSync(filePath)) return []
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-Math.max(1, limit))
  },

  listLogFiles(): LogFileInfo[] {
    const dir = ensureLogDir()
    return fs.readdirSync(dir)
      .filter(name => name.startsWith('anovel-') && name.endsWith('.log'))
      .map(name => {
        const filePath = path.join(dir, name)
        const stat = fs.statSync(filePath)
        return {
          name,
          path: filePath,
          size: stat.size,
          mtime: stat.mtime.toISOString()
        }
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime))
  },

  startup(): void {
    this.info('app', 'ANovel 启动', {
      version: app.getVersion?.() ?? 'unknown',
      platform: process.platform,
      cwd: process.cwd(),
      logDir: this.getLogDir()
    })
  }
}
