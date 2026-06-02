export const LOCAL_FILE_SCHEME = 'local-file'

/** 将绝对路径转为渲染进程可加载的 local-file:// URL */
export function toLocalFileUrl(absPath: string | null | undefined): string | null {
  if (!absPath) return null
  const raw = absPath.startsWith('file://') ? absPath.slice('file://'.length) : absPath
  const normalized = raw.replace(/\\/g, '/')
  const pathPart = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `${LOCAL_FILE_SCHEME}://${encodeURI(pathPart.slice(1))}`
}
