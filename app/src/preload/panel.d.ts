import type { PanelApi } from './panel'

declare global {
  interface Window {
    argus: PanelApi
  }
}
