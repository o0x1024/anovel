/** 将渲染进程错误写入主进程 logs/anovel-*.log */
export async function reportRendererError(
  category: string,
  message: string,
  meta?: Record<string, unknown>
): Promise<void> {
  try {
    await window.anovel.invoke('log:write', 'ERROR', category, message, meta ?? {})
  } catch {
    console.error(`[${category}]`, message, meta ?? '')
  }
}
