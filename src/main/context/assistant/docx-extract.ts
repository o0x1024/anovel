import mammoth from 'mammoth'

export async function extractTextFromDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer })
  const text = result.value.trim()
  if (!text) {
    throw new Error('docx 文件中未提取到文本内容')
  }
  return text
}

export function isDocxFileName(fileName: string): boolean {
  return /\.docx$/i.test(fileName)
}
