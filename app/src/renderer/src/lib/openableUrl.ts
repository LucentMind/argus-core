/**
 * Mirrors main's `isOpenableUrl` (services/presets.ts). A corpus-controlled url
 * is untrusted remote input: it must never reach an anchor that could carry
 * `file://`, `javascript:` or an app-protocol scheme. Main guards the
 * `setWindowOpenHandler` chokepoint; this is the anchor-side half of spec §12.1,
 * and jsdom cannot exercise the main-side half at all.
 */
export function isOpenableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}
