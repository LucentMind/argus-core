import type { ElectronAPI } from '@electron-toolkit/preload'
import type { ArgusApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    argus: ArgusApi
  }
}
