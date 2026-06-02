export {}

declare global {
  interface Window {
    anovel: {
      getAppInfo: () => Promise<{ version: string; name: string; platform: string }>
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
      on: (channel: string, callback: (...args: unknown[]) => void) => void
      off: (channel: string, callback: (...args: unknown[]) => void) => void
    }
  }
}
