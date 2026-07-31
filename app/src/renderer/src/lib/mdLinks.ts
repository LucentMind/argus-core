/**
 * Spec §6.3, half one: resolve real markdown links.
 *
 * An earlier framing assumed skills cite `references/*.md`. They do not — references are flat
 * files in one shared directory, and the only link convention that actually exists is `INDEX.md`
 * linking siblings as `[Title](name.md)` (refSync/engine.ts's `generateReferencesIndex`). So
 * resolution is deliberately **basename-only against the known reference set**, not real path
 * resolution: it makes `[a](a.md)`, `[a](./a.md)` and `[a](../references/a.md)` all work, and it
 * needs no notion of where the containing file lives — which matters, because a skill lives in
 * its own directory and a reference does not.
 */
export interface MdLink {
  /** Offset of `[` in the document. */
  from: number
  /** Offset one past the closing `)`. */
  to: number
  target: string
}

// `(?<!!)` drops images. `[^\]\n]` keeps the label on one line, so an unclosed bracket cannot
// swallow the rest of the file. The optional trailing group eats a `"title"` attribute.
const LINK_RE = /(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g

export function scanLinks(doc: string): MdLink[] {
  const out: MdLink[] = []
  // A fresh RegExp per call: a module-level /g regex carries `lastIndex` between calls, which
  // would make this return different results for the same input depending on call order.
  const re = new RegExp(LINK_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(doc)) !== null) {
    out.push({ from: m.index, to: m.index + m[0].length, target: m[1]! })
  }
  return out
}

/**
 * The reference this link points at, or `null` when it points nowhere the editor can open.
 *
 * `null` is not an error — it is what earns the subtle underline-warning decoration (§6.3).
 */
export function resolveLink(target: string, known: readonly string[]): string | null {
  // Anchor and query first, so `a.md#x` is a link to `a.md` and a bare `#x` becomes empty.
  const bare = target.split(/[#?]/)[0] ?? ''
  if (bare === '') return null
  // Absolute URLs, protocol-relative URLs and absolute paths are all outside the editor's world.
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith('//') || bare.startsWith('/'))
    return null
  let decoded: string
  try {
    decoded = decodeURIComponent(bare)
  } catch {
    // A malformed escape is a broken link, not a crash.
    return null
  }
  const base = decoded.split('/').pop() ?? ''
  if (!base.toLowerCase().endsWith('.md')) return null
  const exact = known.find((k) => k === base)
  if (exact) return exact
  // Case-insensitive fallback, returning the KNOWN spelling: reference filenames come off a
  // case-preserving, case-insensitive filesystem on Windows, so `routing.md` in prose and
  // `Routing.md` on disk are the same file and a case-exact match alone would flag it broken.
  const lower = base.toLowerCase()
  return known.find((k) => k.toLowerCase() === lower) ?? null
}
