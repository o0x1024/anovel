export function sampleDocumentText(fullText: string, maxChars = 4000): string {
  const text = fullText.trim()
  if (text.length <= maxChars) return text

  const len = text.length
  const chunk = Math.floor(maxChars / 4)
  const slice = (start: number, size: number) => text.slice(Math.max(0, start), start + size)

  const parts = [
    slice(0, chunk),
    slice(Math.floor(len * 0.35) - Math.floor(chunk / 2), chunk),
    slice(Math.floor(len * 0.65) - Math.floor(chunk / 2), chunk),
    slice(Math.max(0, len - chunk), chunk)
  ]

  return parts
    .map(p => p.trim())
    .filter(p => p.length > 8)
    .join('\n\n')
}
