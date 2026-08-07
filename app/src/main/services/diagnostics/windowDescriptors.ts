import type { WindowDescriptor } from './labels'

/**
 * One `webContents`, reduced to the four facts classification needs.
 *
 * The Electron calls that produce these live in index.ts; this module is pure so
 * the ordering rules below are testable without a running app.
 */
export type WindowSource = {
  id: number
  /** `getOSProcessId()`, or null when the call threw or the contents was destroyed. */
  osPid: number | null
  isBrowserWindow: boolean
  /** The owning panel's title, or null when this is not a panel. May legitimately be ''. */
  panelTitle: string | null
  isMain: boolean
}

/**
 * Classify each webContents into a diagnostics window descriptor.
 *
 * Order is load-bearing: PANEL is checked first because a floated panel is ALSO a
 * BrowserWindow (the float-out host at panels/electronPlatform.ts), and checking
 * windows first would label it "Editor window".
 *
 * A source with no os pid is skipped. That is not merely defensive — the panel
 * float-out host never loads content, so Chromium spawns no renderer for it and
 * `getOSProcessId()` returns 0. This guard is what keeps it off the page.
 */
export function collectWindowDescriptors(sources: readonly WindowSource[]): WindowDescriptor[] {
  const out: WindowDescriptor[] = []
  for (const s of sources) {
    if (s.osPid === null || s.osPid <= 0) continue
    if (s.panelTitle !== null) {
      out.push({ osPid: s.osPid, kind: 'panel', title: s.panelTitle })
      continue
    }
    if (s.isMain) {
      out.push({ osPid: s.osPid, kind: 'main-window' })
      continue
    }
    if (s.isBrowserWindow) out.push({ osPid: s.osPid, kind: 'editor-window' })
  }
  return out
}
