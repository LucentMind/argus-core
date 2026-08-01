/**
 * The pure options literals spread into `new BrowserWindow(...)` for the main and editor windows
 * (spec 2026-08-01-frameless-chrome-increment-2, review recommendation 6).
 *
 * `createWindow()` in index.ts boots Electron at module scope, so nothing in that file can be
 * imported under vitest (house DI convention: no `vi.mock('electron')`) — the window-construction
 * commit that made both windows frameless shipped with no unit test as a result, and the CDP gate
 * meant to stand in for one turned out to measure the wrong window. Everything about window
 * construction that IS a pure function of its inputs is pulled out here so a test can assert the
 * literal directly, no Electron involved.
 *
 * `titleBar.ts` owns the theme/scale → overlay decision and stays Electron-free and scoped to
 * that one concern; this module is one layer up, folding in the icon and preload paths that are
 * not title-bar decisions but do belong in the same spread at each call site.
 */
import { titleBarWindowOptions, type TitleBarTheme, type TitleBarWindowOptions } from './titleBar'

/** The `webPreferences` shape both windows pass — `sandbox: false` is fixed, only the preload
 *  path varies. */
interface WindowPreferences {
  webPreferences: { preload: string; sandbox: false }
}

export type MainWindowOptions = TitleBarWindowOptions & WindowPreferences & { icon: string }
export type EditorWindowOptions = TitleBarWindowOptions & WindowPreferences

/**
 * Spread into `new BrowserWindow({...})` in `createWindow()` (index.ts). The sibling keys that
 * stay literal at that call site — `width`, `height`, `minWidth`, `minHeight`, `show`,
 * `autoHideMenuBar` — don't vary with theme/scale/icon/preload, so they never moved in here; see
 * windowOptions.test.ts for the assertion that this function's keys never collide with them.
 */
export function mainWindowOptions(
  theme: TitleBarTheme,
  scale: number,
  iconPath: string,
  preloadPath: string,
  platform: NodeJS.Platform = process.platform
): MainWindowOptions {
  return {
    icon: iconPath,
    ...titleBarWindowOptions('main', theme, platform, scale),
    webPreferences: { preload: preloadPath, sandbox: false }
  }
}

/**
 * The editor-window counterpart, spread in `makeElectronEditorWindowFactory`
 * (electronEditorWindow.ts). `width`/`height`/`x`/`y` stay at that call site: they come from
 * `clampToDisplays`'s already-computed bounds, not from theme/scale/preload, so there is nothing
 * pure to extract them from without also taking the bounds computation with them. The editor
 * window carries no icon of its own (the taskbar/dock icon comes from the packaged app), so this
 * takes one fewer parameter than {@link mainWindowOptions}.
 */
export function editorWindowOptions(
  theme: TitleBarTheme,
  scale: number,
  preloadPath: string,
  platform: NodeJS.Platform = process.platform
): EditorWindowOptions {
  return {
    ...titleBarWindowOptions('editor', theme, platform, scale),
    webPreferences: { preload: preloadPath, sandbox: false }
  }
}
