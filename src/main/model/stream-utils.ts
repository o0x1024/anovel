import type { IncomingMessage } from 'http'

export interface StreamParseResult {
  content: string
  usage?: { promptTokens: number; completionTokens: number }
}

export function consumeSseStream(
  stream: IncomingMessage,
  onEvent: (data: string) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let settled = false

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }

    const onAbort = () => {
      stream.destroy()
      finish(new DOMException('Aborted', 'AbortError'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        onEvent(data)
      }
    })

    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      finish()
    })

    stream.on('error', (err: Error) => {
      signal?.removeEventListener('abort', onAbort)
      finish(err)
    })
  })
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}
