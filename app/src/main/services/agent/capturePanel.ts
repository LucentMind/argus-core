const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** Filesystem-safe slug from a panel title; falls back to the windowId, then 'panel'. */
export function slugifyPanelTitle(title: string, fallback: string): string {
  return slug(title) || slug(fallback) || 'panel'
}

/** Compact UTC timestamp for filenames: 2026-07-14T15:30:12.123Z -> 20260714T153012Z. */
export function compactStamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')
}
