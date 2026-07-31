/**
 * The editor window's own title bar (spec 2026-07-31-frameless-window-chrome).
 *
 * The window is frameless, so this strip is the only thing the user can drag it by, and the OS
 * paints min/max/close over its right end — `argus-titlebar-inset` is what keeps this label out
 * from under them.
 *
 * It shows the app name rather than the open file: `TabBar` renders the filename directly below,
 * and a title bar repeating it would be noise. This is the same string the taskbar and Alt-Tab
 * show, which comes from the window's `title` in electronEditorWindow.ts — keep the two in step.
 */
export function WindowTitleBar(): React.JSX.Element {
  return (
    <div className="argus-drag argus-titlebar-inset flex h-10 shrink-0 items-center text-xs text-dim">
      Argus — Editor
    </div>
  )
}
