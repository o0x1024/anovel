const STORAGE_KEY = 'anovel:editor-panel-pages'
const SELECTION_STORAGE_KEY = 'anovel:editor-panel-selections'

type PageMap = Record<string, number>
type SelectionMap = Record<string, number>

function readMap(): PageMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PageMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(map: PageMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore quota / private mode
  }
}

function readSelectionMap(): SelectionMap {
  try {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as SelectionMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSelectionMap(map: SelectionMap): void {
  try {
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore quota / private mode
  }
}

function makeKey(panel: string, workId: number, volumeId: number | null | undefined): string {
  return `${panel}:${workId}:${volumeId ?? '_'}`
}

export function getPanelPage(
  panel: string,
  workId: number,
  volumeId?: number | null
): number {
  const map = readMap()
  const value = map[makeKey(panel, workId, volumeId)]
  return typeof value === 'number' && value > 0 ? value : 1
}

export function setPanelPage(
  panel: string,
  workId: number,
  volumeId: number | null | undefined,
  page: number
): void {
  const map = readMap()
  map[makeKey(panel, workId, volumeId)] = page
  writeMap(map)
}

export function getPanelSelection(
  panel: string,
  workId: number,
  volumeId?: number | null
): number | null {
  const map = readSelectionMap()
  const value = map[makeKey(panel, workId, volumeId)]
  return typeof value === 'number' ? value : null
}

export function setPanelSelection(
  panel: string,
  workId: number,
  volumeId: number | null | undefined,
  chapterId: number | null
): void {
  const map = readSelectionMap()
  const key = makeKey(panel, workId, volumeId)
  if (chapterId == null) {
    delete map[key]
  } else {
    map[key] = chapterId
  }
  writeSelectionMap(map)
}
