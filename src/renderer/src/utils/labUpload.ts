function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export async function parseLabFile(file: File): Promise<string> {
  const lowerName = file.name.toLowerCase()
  if (!(lowerName.endsWith('.txt') || lowerName.endsWith('.md') || lowerName.endsWith('.docx'))) {
    throw new Error('仅支持 .txt、.md、.docx 格式')
  }
  const arrayBuffer = await file.arrayBuffer()
  const base64 = toBase64(new Uint8Array(arrayBuffer))
  const text = await window.anovel.invoke('lab:parseFile', {
    fileName: file.name,
    base64
  }) as string
  if (!text.trim()) throw new Error('文件中未识别到有效文本')
  return text
}

export const LAB_UPLOAD_ACCEPT =
  '.txt,.md,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
