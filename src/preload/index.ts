import { contextBridge, ipcRenderer } from 'electron'
import { toPlainForIpc, toPlainIpcArgs } from '../shared/ipc-plain'

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('anovel', {
  // 应用信息
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),

  // 通用 IPC 调用（参数/返回值剥离 Vue Proxy，避免 "could not be cloned"）
  invoke: async (channel: string, ...args: unknown[]) => {
    try {
      const result = await ipcRenderer.invoke(channel, ...toPlainIpcArgs(args))
      return toPlainForIpc(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (channel !== 'log:write') {
        void ipcRenderer
          .invoke('log:write', 'ERROR', 'ipc', `${channel}: ${message}`, {
            channel,
            stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined
          })
          .catch(() => undefined)
      }
      throw err
    }
  },

  // 监听主进程事件
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args))
  },

  off: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, callback)
  }
})
