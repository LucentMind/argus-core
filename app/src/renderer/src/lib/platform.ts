/**
 * The renderer's view of `process.platform`, surfaced by preload as `window.argus.platform`.
 *
 * Its own module rather than a helper inside a component file: react-refresh requires a component
 * module to export only components (same reason `settingsPages.ts` sits outside `SettingsView`).
 *
 * Optional-chained because a stale test fake — or a preload predating the `platform` key — leaves
 * it undefined, and the honest answer there is "not darwin", which is the branch that renders our
 * own buttons.
 */
export function isDarwin(): boolean {
  return window.argus?.platform === 'darwin'
}
