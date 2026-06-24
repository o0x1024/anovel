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

function isReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return typeof value === 'object' && value !== null && typeof (value as NodeJS.ReadableStream).on === 'function'
}

async function readStreamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 从 axios 错误中提取 API 返回的 message（含 responseType: stream 时的响应体） */
export async function parseAxiosErrorMessage(error: unknown): Promise<string> {
  const axiosError = error as {
    response?: { data?: unknown }
    message?: string
  }
  const data = axiosError.response?.data
  if (data == null) {
    return axiosError.message ?? '未知错误'
  }

  let parsed: unknown
  if (isReadableStream(data)) {
    const text = await readStreamToString(data).catch(() => '')
    if (!text.trim()) return axiosError.message ?? '未知错误'
    try {
      parsed = JSON.parse(text)
    } catch {
      return text.trim()
    }
  } else if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data)
    } catch {
      return data.trim() || axiosError.message || '未知错误'
    }
  } else {
    parsed = data
  }

  const apiMessage = (parsed as { error?: { message?: string } })?.error?.message
  return apiMessage ?? axiosError.message ?? '未知错误'
}
