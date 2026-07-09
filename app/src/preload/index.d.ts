import type { ArgusApi } from './index'

declare global {
  interface Window {
    argus: ArgusApi
  }
}
