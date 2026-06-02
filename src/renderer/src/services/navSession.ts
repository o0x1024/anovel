const STORAGE_KEY = 'nav:lastPaths'

type NavPathMap = Record<string, string>

function readMap(): NavPathMap {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as NavPathMap
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(map: NavPathMap): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore quota / private mode
  }
}

/** 将具体路由映射到侧边栏菜单项 path */
export function navKeyForPath(path: string): string {
  const normalized = path.split('?')[0].split('#')[0]
  if (normalized.startsWith('/work/')) return '/'
  return normalized
}

export function saveNavPath(path: string, fullPath: string): void {
  const key = navKeyForPath(path)
  const map = readMap()
  map[key] = fullPath
  writeMap(map)
}

export function getNavRestorePath(navPath: string, fallbackPath: string): string {
  const map = readMap()
  const saved = map[navPath]
  if (!saved) return fallbackPath
  const savedPath = saved.split('?')[0].split('#')[0]
  if (navKeyForPath(savedPath) === navPath) return saved
  return fallbackPath
}
