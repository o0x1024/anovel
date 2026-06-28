const pad = (n: number, len = 2): string => String(n).padStart(len, '0')

/** 本地日期 YYYY-MM-DD（日志文件名等） */
export function localDateString(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地日期时间，含毫秒（日志行时间戳） */
export function formatLocalDateTime(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** 将数据库 UTC 时间字符串格式化为本地显示 */
export function formatDbUtcAsLocal(dateStr: string): string {
  if (!dateStr) return ''
  const iso = dateStr.includes('T') ? dateStr : `${dateStr.replace(' ', 'T')}Z`
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}
