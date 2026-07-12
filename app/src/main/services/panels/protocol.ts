import path from 'node:path'

/** Locates one pack's webPanel bundle on disk (from PackRegistry.windowDecls()). */
export interface PanelWindowLoc {
  packId: string
  windowId: string
  uiDir: string
  /** The window's HTML entry, e.g. "text-viewer/index.html" (loader-validated: forward-slash, contained). */
  entry: string
}

interface PanelUrlParts {
  packId: string
  windowId: string
  relpath: string
}

function parsePanelUrl(url: string): PanelUrlParts | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'argus-panel:') return null
  const packId = u.hostname
  const segs = u.pathname.replace(/^\/+/, '').split('/')
  const windowId = segs.shift() ?? ''
  const relpath = segs.join('/')
  if (!packId || !windowId || !relpath) return null
  return { packId, windowId, relpath }
}

/** True when `rel` is a contained forward-slash relative path (no absolute, no backslash, no '..', no empty seg). */
function isContained(rel: string): boolean {
  if (rel === '' || path.isAbsolute(rel) || rel.includes('\\')) return false
  return !rel.split('/').some((seg) => seg === '..' || seg === '')
}

/**
 * Resolve an argus-panel:// URL to an absolute file path inside the window's
 * bundle subtree (`<uiDir>/<dirname(entry)>/<relpath>`), or null when the URL
 * is malformed, targets an unknown window, or escapes the bundle.
 */
export function resolvePanelAsset(windows: PanelWindowLoc[], url: string): string | null {
  const parts = parsePanelUrl(url)
  if (!parts) return null
  const win = windows.find((w) => w.packId === parts.packId && w.windowId === parts.windowId)
  if (!win) return null
  if (!isContained(parts.relpath)) return null
  // entry is loader-validated forward-slash; its dirname is the window's bundle root.
  const entryDir = path.posix.dirname(win.entry)
  const bundleRoot = path.join(win.uiDir, ...entryDir.split('/').filter((s) => s && s !== '.'))
  const abs = path.join(bundleRoot, ...parts.relpath.split('/'))
  const rel = path.relative(bundleRoot, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

/**
 * Strict per-panel CSP built from the window's declared network allowlist.
 * Empty allowlist ⇒ the panel can reach only its own bundle. No unsafe-inline/eval.
 */
export function buildPanelCsp(network: string[]): string {
  const allow = network.filter((o) => o && o.trim().length > 0)
  const tail = allow.length ? ' ' + allow.join(' ') : ''
  return [
    `default-src 'none'`,
    `script-src 'self'`,
    `style-src 'self'`,
    `img-src 'self' data:${tail}`,
    `font-src 'self'`,
    `connect-src 'self'${tail}`,
    `frame-ancestors 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`
  ].join('; ')
}
