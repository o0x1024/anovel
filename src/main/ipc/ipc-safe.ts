import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'
import { toPlainForIpc } from '../../shared/ipc-plain'
import { appLogger } from '../logger/app-logger'

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/**
 * 主进程 IPC 安全包装：入参/返回值 JSON 化，避免 structured clone 失败；
 * 异常写入 logs/anovel-*.log。
 */
export function safeIpcHandle(channel: string, handler: IpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const plainArgs = args.map(arg => toPlainForIpc(arg))
    try {
      const result = await handler(event, ...plainArgs)
      return toPlainForIpc(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      appLogger.error('ipc', `${channel} 调用失败`, {
        channel,
        error: message,
        stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined
      })
      throw err
    }
  })
}
