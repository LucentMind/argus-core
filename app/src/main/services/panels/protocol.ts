import path from 'node:path'
import { caseDir } from '../paths'

/** Regex to validate a CSP origin: scheme://host with no whitespace, semicolons, quotes, or angle brackets. */
const ORIGIN_RE = /^[a-z][a-z0-9+.-]*:\/\/[^\s;'"<>]+$/i

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

interface CaseUrlParts {
  caseSlug: string
  relpath: string
}

/** Matches '..' only as a path segment (bounded by '/' or string start/end), not as a filename substring. */
const DOTDOT_SEGMENT_RE = /(^|\/)\.\.(\/|$)/

function parseCaseUrl(url: string): CaseUrlParts | null {
  // Reject '..' path segments (traversal) in the raw URL before WHATWG URL
  // parsing normalizes them away. This must not match '..' as a bare
  // substring, or legitimate filenames like "notes..final.pdf" would be
  // falsely rejected.
  if (DOTDOT_SEGMENT_RE.test(url)) return null

  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'argus-case:') return null
  const caseSlug = u.hostname
  let relpath = u.pathname
  if (relpath.startsWith('/')) relpath = relpath.slice(1)
  if (!caseSlug || !relpath || relpath.startsWith('/')) return null
  return { caseSlug, relpath }
}

/**
 * Resolve an argus-case:// URL to an absolute file path under the BOUND case's
 * evidence/ dir, or null when the URL is malformed, escapes that directory, or
 * names a different case than the one the panel's session partition is bound to.
 * Coarse by design (spec §7): serves any file under evidence/, not just
 * registered evidence rows — same trust posture argus-panel:// uses for a
 * pack's own bundle. Does not check the case exists in the DB; a nonexistent
 * case's evidence dir simply has nothing to read (caller 404s on fs failure).
 *
 * `boundCaseSlug` (from the panel's session partition, e.g.
 * `pack-panel:<packId>:<caseSlug>`) is the ONLY trusted case identity. The
 * URL's hostname is renderer-supplied and untrusted — a panel bound to CASE-A
 * could otherwise request `argus-case://CASE-B/...` and read another case's
 * evidence. The path is always built from `boundCaseSlug`, never from the
 * URL hostname, so a URL naming any other case is rejected outright.
 */
export function resolveCaseAsset(
  argusHome: string,
  boundCaseSlug: string,
  url: string
): string | null {
  const parts = parseCaseUrl(url)
  if (!parts) return null
  // The bound case (from the panel's session partition) is authoritative. A URL naming a
  // different case is a cross-case attempt — reject it. Compare case-insensitively so a
  // standard-scheme host canonicalized to lowercase by Chromium still matches the bound slug.
  if (parts.caseSlug.toLowerCase() !== boundCaseSlug.toLowerCase()) return null
  // '..' path-segment traversal is already rejected in parseCaseUrl; the
  // containment checks below (isContained + the path.relative re-verify)
  // guard against absolute paths, backslashes, and empty segments.
  if (!isContained(parts.relpath)) return null
  // Build the path from the TRUSTED boundCaseSlug (correct on-disk casing), never from the
  // renderer-supplied URL hostname.
  const evidenceDir = path.join(caseDir(argusHome, boundCaseSlug), 'evidence')
  const abs = path.join(evidenceDir, ...parts.relpath.split('/'))
  const rel = path.relative(evidenceDir, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

/** MIME type for an argus-panel asset by extension. */
export function panelContentType(file: string): string {
  const ext = path.extname(file).toLowerCase()
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.pdf': 'application/pdf',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.txt': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8'
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * Strict per-panel CSP built from the window's declared network allowlist.
 * Empty allowlist ⇒ the panel can reach only its own bundle. No unsafe-inline/eval.
 * Malformed origins (containing directive-injection chars like `;`, spaces, or quotes) are dropped.
 * `opts.allowCaseFiles` (3d-1, readCaseFiles-granted windows only) additionally allows the
 * argus-case: scheme in img-src/connect-src and adds a media-src directive — otherwise the
 * CSP is unchanged from 3a/3b (no media-src at all; default-src 'none' blocks media elements).
 */
export function buildPanelCsp(network: string[], opts: { allowCaseFiles?: boolean } = {}): string {
  const allow = network.filter((o) => {
    if (!o || o.trim().length === 0) return false
    if (!ORIGIN_RE.test(o)) {
      console.warn(`[panels] ignoring malformed panel network origin: ${o}`)
      return false
    }
    return true
  })
  const tail = allow.length ? ' ' + allow.join(' ') : ''
  const caseSrc = opts.allowCaseFiles ? ' argus-case:' : ''
  const directives = [
    `default-src 'none'`,
    `script-src 'self'`,
    `style-src 'self'`,
    `img-src 'self' data:${caseSrc}${tail}`
  ]
  if (opts.allowCaseFiles) directives.push(`media-src 'self'${caseSrc}${tail}`)
  directives.push(
    `font-src 'self'`,
    `connect-src 'self'${caseSrc}${tail}`,
    `frame-ancestors 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`
  )
  return directives.join('; ')
}
