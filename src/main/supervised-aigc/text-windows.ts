export interface SupervisedTextWindow {
  start: number
  end: number
  text: string
}

export function buildSupervisedTextWindows(text: string): SupervisedTextWindow[] {
  const maximumChars = 480
  const overlapChars = 160
  const minimumSplitChars = 320
  if (text.length <= maximumChars) return [{ start: 0, end: text.length, text }]

  const windows: SupervisedTextWindow[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maximumChars)
    if (end < text.length) {
      const candidate = text.slice(start + minimumSplitChars, end)
      const punctuation = Math.max(
        candidate.lastIndexOf('。'), candidate.lastIndexOf('！'), candidate.lastIndexOf('？'),
        candidate.lastIndexOf('；'), candidate.lastIndexOf('\n')
      )
      if (punctuation >= 0) end = start + minimumSplitChars + punctuation + 1
    }
    windows.push({ start, end, text: text.slice(start, end) })
    if (end >= text.length) break
    start = Math.max(start + 1, end - overlapChars)
  }
  return windows
}
