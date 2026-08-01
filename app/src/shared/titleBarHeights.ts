/**
 * Title bar strip heights, shared between the renderer (which lays out `TitleBarStrip`) and the
 * main process (which sizes `titleBarOverlay`'s native button hit-box). One source of truth makes
 * the renderer↔main height coupling structural rather than a comment that can drift.
 *
 * `main: 32` — the main window's strip is bare (window buttons only, nothing else); it does not
 * match `TopBar`'s `h-16` the way it briefly did. `editor: 40` is unchanged.
 *
 * NOTE: `app/src/shared/*` must never import from `app/src/main/*` — `tsconfig.web.json` excludes
 * `src/main`, so such an import would drag main-only types into the renderer typecheck. This file
 * has no imports at all, by design.
 */
export const TITLEBAR_HEIGHTS = { main: 32, editor: 40 } as const

export type TitleBarKind = keyof typeof TITLEBAR_HEIGHTS
