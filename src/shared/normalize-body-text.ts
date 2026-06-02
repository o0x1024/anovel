/** 注入 prompt：要求模型按网文排版输出 */
export const BODY_PARAGRAPH_SPACING_RULE =
  ''

/**
 * 网文正文排版：段间单换行，去掉 AI 常输出的 Markdown 章节标题与多余空行。
 */
export function normalizeBodyParagraphSpacing(text: string): string {
  let result = text.trim()
  if (!result) return result

  result = result.replace(/^#{1,3}\s*第?\s*[0-9一二三四五六七八九十百千万]+章[^\n]*\n+/m, '')
  result = result.replace(/\r\n/g, '\n')
  result = result.replace(/\n{3,}/g, '\n')
  result = result.replace(/\n\n+/g, '\n')

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
