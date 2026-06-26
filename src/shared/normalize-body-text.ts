/** 注入 prompt：要求模型按网文排版输出 */
export const BODY_PARAGRAPH_SPACING_RULE =
  ''

const CLOSING_QUOTES = '"”」』'

const FORBIDDEN_NOT_IS_PATTERNS: RegExp[] = [
  /，?这不是[^。！？；，\n]{1,40}，?这是/g,
  /，?那不是[^。！？；，\n]{1,40}，?那是/g,
  /，?不是[^。！？；，\n]{1,40}，?而是/g,
  /，?不是[^。！？；，\n]{1,40}，?是/g
]

export function stripForbiddenNotIsPatterns(text: string): string {
  let result = text
  for (const pattern of FORBIDDEN_NOT_IS_PATTERNS) {
    result = result.replace(pattern, '')
  }
  return result
    .replace(/，{2,}/g, '，')
    .replace(/^[，；、\s]+/gm, '')
    .replace(/([。！？；])，/g, '$1')
    .replace(/，([。！？；])/g, '$1')
}

/**
 * 修复 AI 生成文本中「用句号代替逗号」的问题。
 * 当连续短句共享主语（后句省略主语）且语义连贯时，将中间的句号替换为逗号。
 */
export function fixPeriodAsComma(text: string): string {
  const lines = text.split('\n')
  return lines.map(line => limitPeriodsPerParagraph(fixPeriodAsCommaInLine(line))).join('\n')
}

function fixPeriodAsCommaInLine(line: string): string {
  if (!line.trim()) return line
  const segments = line.split(/(?<=。)/)
  if (segments.length < 2) return line

  const result: string[] = []
  let i = 0
  while (i < segments.length) {
    const cur = segments[i]
    if (i === segments.length - 1) {
      result.push(cur)
      i++
      continue
    }

    const curBody = cur.replace(/。$/, '')
    const next = segments[i + 1]
    const nextBody = next.replace(/。$/, '')

    if (shouldMergeWithComma(curBody, nextBody)) {
      result.push(curBody + '，')
    } else {
      result.push(cur)
    }
    i++
  }
  return result.join('')
}

/**
 * 判定两个相邻短句是否应合并（句号→逗号）。
 * 条件：前句 ≤15字，后句 ≤15字，后句无显式主语（省略主语的连续动作/描写）。
 */
function shouldMergeWithComma(cur: string, next: string): boolean {
  if (!cur || !next) return false
  const curClean = cur.replace(/[^\u4e00-\u9fff\w]/g, '')
  const nextClean = next.replace(/[^\u4e00-\u9fff\w]/g, '')
  if (curClean.length > 15 || nextClean.length > 15) return false
  if (curClean.length < 2 || nextClean.length < 2) return false

  if (isDialogue(cur) || isDialogue(next)) return false

  if (startsWithExplicitSubject(next)) return false

  return true
}

function limitPeriodsPerParagraph(line: string): string {
  if (!line.trim()) return line
  const periodIndexes = [...line.matchAll(/。/g)].map(match => match.index ?? 0)
  if (periodIndexes.length <= 1) return line

  const keepIndex = choosePeriodToKeep(line, periodIndexes)
  let result = ''
  let last = 0
  for (const index of periodIndexes) {
    result += line.slice(last, index)
    result += index === keepIndex ? '。' : '，'
    last = index + 1
  }
  result += line.slice(last)
  return result
}

function choosePeriodToKeep(line: string, periodIndexes: number[]): number {
  for (let i = periodIndexes.length - 1; i >= 0; i--) {
    const nextChar = line[periodIndexes[i] + 1]
    if (!nextChar || !CLOSING_QUOTES.includes(nextChar)) return periodIndexes[i]
  }
  return periodIndexes[periodIndexes.length - 1]
}

function isDialogue(s: string): boolean {
  return /[""「『【]/.test(s)
}

const SUBJECT_STARTERS = /^(?:[他她它我你们您咱俩这那谁哪][们的]?|[^\u4e00-\u9fff])/

function startsWithExplicitSubject(s: string): boolean {
  const trimmed = s.replace(/^[，。、；：！？…—\s]+/, '')
  if (!trimmed) return false
  if (SUBJECT_STARTERS.test(trimmed)) return true
  if (/^[\u4e00-\u9fff]{2,4}(?:说|道|想|看|听|问|笑|叹|喊|叫)/.test(trimmed)) return true
  return false
}

/**
 * 网文正文排版：段间单换行，去掉 AI 常输出的 Markdown 章节标题与多余空行。
 */
export function normalizeBodyParagraphSpacing(text: string): string {
  let result = text.trim()
  if (!result) return result

  result = result.replace(/^#{1,3}\s*第?\s*[0-9一二三四五六七八九十百千万]+章[^\n]*\n+/m, '')
  result = result.replace(/\r\n/g, '\n')
  result = stripForbiddenNotIsPatterns(result)
  result = result.replace(/\n{3,}/g, '\n')
  result = result.replace(/\n\n+/g, '\n')
  result = fixPeriodAsComma(result)

  return result.trim()
}

export function shouldNormalizeBodySpacing(step?: string): boolean {
  if (!step) return false
  if (step === 'lab_deai' || step === 'ai_trace_polish') return true
  return step === 'body_generation' || step.startsWith('body_')
}

/** 模型正文类步骤返回前统一段落换行 */
export function normalizeModelBodyOutput(content: string | undefined | null, step?: string): string {
  if (!content) return content ?? ''
  if (!shouldNormalizeBodySpacing(step)) return content
  return normalizeBodyParagraphSpacing(content)
}
