import DOMPurify from 'dompurify'
import { marked } from 'marked'

const MARKDOWN_OPTIONS = {
  gfm: true,
  breaks: true,
  async: false as const
}

export function renderMarkdown(content: string): string {
  const rawHtml = marked.parse(content || '', MARKDOWN_OPTIONS) as string
  return DOMPurify.sanitize(rawHtml)
}
