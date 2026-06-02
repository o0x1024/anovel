export interface UploadedAssistantDocument {
  id: number
  title: string
}

export async function uploadAssistantDocument(file: File): Promise<UploadedAssistantDocument> {
  const lowerName = file.name.toLowerCase()

  if (lowerName.endsWith('.docx')) {
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    const base64 = btoa(binary)
    const doc = await window.anovel.invoke('assistant:docUploadBinary', {
      fileName: file.name,
      title: file.name.replace(/\.docx$/i, ''),
      base64
    }) as UploadedAssistantDocument
    return doc
  }

  if (lowerName.endsWith('.txt') || lowerName.endsWith('.md')) {
    const content = await file.text()
    const doc = await window.anovel.invoke('assistant:docUpload', {
      title: file.name.replace(/\.(txt|md)$/i, ''),
      fileName: file.name,
      content
    }) as UploadedAssistantDocument
    return doc
  }

  throw new Error('仅支持 .txt、.md、.docx 格式')
}

export const ASSISTANT_UPLOAD_ACCEPT = '.txt,.md,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
