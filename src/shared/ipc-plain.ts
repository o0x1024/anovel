/**
 * Electron IPC 使用 structured clone，不能传递 Vue reactive Proxy、函数、DOM 等。
 * 跨进程前/后统一转为可 JSON 序列化的纯对象。
 */
export function toPlainForIpc<T>(value: T): T {
  if (value === undefined || value === null) return value
  const t = typeof value
  if (t === 'number' || t === 'string' || t === 'boolean') return value
  return JSON.parse(JSON.stringify(value)) as T
}

export function toPlainIpcArgs(args: unknown[]): unknown[] {
  return args.map(arg => toPlainForIpc(arg))
}
