/**
 * Title bar heights, shared between the renderer and the main process. One source of truth makes
 * the renderer↔main height coupling structural rather than a comment that can drift.
 *
 * `main: 48` is the **header** height (`TopBar`'s `h-12`). The main window's bare strip is gone —
 * the header carries the window controls itself (spec 2026-08-01-header-window-controls-design.md
 * §3) — so on win32/linux this value has no native consumer at all. Its one remaining job is
 * sizing the darwin `titleBarOverlay`, which is what vertically centres the traffic lights on the
 * header. Change it with `TopBar`'s `h-12`, never alone. `editor: 40` is unchanged.
 *
 * NOTE: `app/src/shared/*` must never import from `app/src/main/*` — `tsconfig.web.json` excludes
 * `src/main`, so such an import would drag main-only types into the renderer typecheck. This file
 * has no imports at all, by design.
 */
export const TITLEBAR_HEIGHTS = { main: 48, editor: 40 } as const

export type TitleBarKind = keyof typeof TITLEBAR_HEIGHTS
