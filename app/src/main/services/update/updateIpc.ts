import { IPC } from '../../../shared/ipc'
import type { CoreUpdaterService } from './coreUpdater'

/**
 * `handle` and `broadcast` are injected rather than importing `ipcMain`/`BrowserWindow`, so the
 * wiring is testable under the house DI convention.
 */
export interface UpdateIpcDeps {
  handle(channel: string, fn: () => unknown): void
  broadcast(channel: string, payload: unknown): void
  service: CoreUpdaterService
}

/** Registers the update channels. Returns a disposer that stops the change broadcasts. */
export function registerUpdateIpc({ handle, broadcast, service }: UpdateIpcDeps): () => void {
  handle(IPC.updateStatus, () => service.payload())
  // Always manual: reaching this handler means the renderer asked, so failures are shown.
  // The silent boot check calls the service directly.
  handle(IPC.updateCheck, () => service.check({ manual: true }))
  handle(IPC.updateDownload, () => service.download())
  handle(IPC.updateRestart, () => service.restart())
  return service.subscribe((payload) => broadcast(IPC.updateChanged, payload))
}
