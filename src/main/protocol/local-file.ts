import { protocol, net } from 'electron'
import { pathToFileURL } from 'url'
import { LOCAL_FILE_SCHEME } from '../../shared/local-file-url'

export function registerLocalFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_FILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true
      }
    }
  ])
}

export function setupLocalFileProtocol(): void {
  protocol.handle(LOCAL_FILE_SCHEME, (request) => {
    const prefix = `${LOCAL_FILE_SCHEME}://`
    const encodedPath = request.url.slice(prefix.length)
    const filePath = decodeURIComponent(encodedPath.startsWith('/') ? encodedPath : `/${encodedPath}`)
    return net.fetch(pathToFileURL(filePath).href)
  })
}
