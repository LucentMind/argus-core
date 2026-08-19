/**
 * Rules for the files a skill directory may carry beside its SKILL.md.
 *
 * Lives in `shared/` because four surfaces must agree on them: the agent write path
 * (`write_proposal`), the accept path, the review panel, and (increment 3) the run gate. Path
 * checks are deliberately string-only — no `node:path` — so a proposal authored on macOS is
 * judged by the same rules on the Windows machine that pulls it.
 */

/** Spec §2 caps. */
export const MAX_ASSET_FILES = 32
export const MAX_ASSET_FILE_BYTES = 64 * 1024
export const MAX_ASSET_TOTAL_BYTES = 256 * 1024
export const MAX_ASSET_DEPTH = 3

export interface SkillAssetInput {
  path: string
  content: string
}

/** Spec §2. `.ts` is here because a skill can legitimately ship a tsx-runner script; the cost of
 *  a false positive is one extra approval prompt, the cost of a false negative is an ungated
 *  script. */
const EXEC_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.ps1',
  '.psm1',
  '.py',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.rb',
  '.pl',
  '.bat',
  '.cmd'
])

/** Rejected on every platform, not just win32: a skill authored on macOS reaches Windows
 *  teammates through HiveMind, where the PULL would break, not the push. */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
])

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function extensionOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** null = legal. The message names the path, so a model can correct and retry. */
export function assetPathError(relPath: string): string | null {
  if (!relPath) return 'file path must not be empty'
  if (relPath.includes('\\')) return `"${relPath}": use / as the path separator`
  if (relPath.startsWith('/')) return `"${relPath}": must be a relative path`
  if (/^[A-Za-z]:/.test(relPath)) return `"${relPath}": must be a relative path`
  if (relPath.toLowerCase() === 'skill.md') {
    return `"${relPath}": SKILL.md is the proposal body, not a sibling file`
  }
  const segments = relPath.split('/')
  if (segments.length > MAX_ASSET_DEPTH) {
    return `"${relPath}": at most ${MAX_ASSET_DEPTH} path segments`
  }
  for (const seg of segments) {
    if (!seg) return `"${relPath}": empty path segment`
    if (seg === '.' || seg === '..') return `"${relPath}": . and .. are not allowed`
    if (!SEGMENT_RE.test(seg)) {
      return `"${relPath}": path segments may use letters, digits, dot, dash and underscore only`
    }
    if (seg.endsWith('.')) return `"${relPath}": path segments must not end with a dot`
    const stem = seg.includes('.') ? seg.slice(0, seg.indexOf('.')) : seg
    if (WINDOWS_RESERVED.has(stem.toLowerCase())) {
      return `"${relPath}": "${stem}" is a reserved name on Windows`
    }
  }
  return null
}

/** null = legal. Per-path rules, then duplicates, then the three caps. */
export function assetSetError(files: SkillAssetInput[]): string | null {
  if (files.length > MAX_ASSET_FILES) {
    return `a skill may carry at most ${MAX_ASSET_FILES} files (got ${files.length})`
  }
  const seen = new Set<string>()
  let total = 0
  for (const f of files) {
    const bad = assetPathError(f.path)
    if (bad) return bad
    if (seen.has(f.path)) return `duplicate file path "${f.path}"`
    seen.add(f.path)
    const bytes = Buffer.byteLength(f.content, 'utf8')
    if (bytes > MAX_ASSET_FILE_BYTES) {
      return `"${f.path}" is ${bytes} bytes; the limit is ${MAX_ASSET_FILE_BYTES} (64 KB) per file`
    }
    total += bytes
  }
  if (total > MAX_ASSET_TOTAL_BYTES) {
    return `the files total ${total} bytes; the limit is ${MAX_ASSET_TOTAL_BYTES} (256 KB) per proposal`
  }
  return null
}

/** Extension list, or a shebang. Drives the review badge, the editor badge and the run gate. */
export function isExecutableAsset(relPath: string, content: string): boolean {
  if (EXEC_EXTENSIONS.has(extensionOf(relPath))) return true
  return content.startsWith('#!')
}
