import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// __dirname = app/src/__tests__ -> up 1 = app/src
const SRC = path.join(__dirname, '..')
const EXT = new Set(['.ts', '.tsx', '.css', '.html'])

/**
 * Mojibake signature: text that was UTF-8, decoded as latin-1, then re-encoded as UTF-8. Every
 * multi-byte character mangled that way becomes a lead character in U+00C2 / U+00C3 / U+00E2
 * followed by one in U+0080..U+00BF: an em dash (E2 80 94) becomes U+00E2 U+0080 U+0094, and a
 * middle dot (C2 B7) becomes U+00C2 U+00B7. Legitimate prose never puts a C1 control or a
 * latin-1 punctuation character directly after one of those three letters, so the pattern is
 * specific to the corruption and does not fire on ordinary accented words.
 *
 * This reached main once (0bb61ed1) and shipped three broken separators in the distill run panel,
 * written by an editor or a patch tool that saved the file as cp1252. Nothing else catches it:
 * the result is still valid UTF-8, so it type-checks, lints, builds and renders - just with
 * garbage glyphs in front of the user. Written with escapes so this file stays pure ASCII.
 */
const MOJIBAKE = new RegExp('[\u00c2\u00c3\u00e2][\u0080-\u00bf]')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (EXT.has(path.extname(e.name))) out.push(p)
  }
  return out
}

describe('source encoding', () => {
  const files = sourceFiles(SRC)

  it('actually walks the source tree', () => {
    // Guards the guard: a walker that silently returned nothing would pass the check below.
    expect(files.length).toBeGreaterThan(500)
    expect(files).toContain(path.join(SRC, 'renderer/src/components/distillRuns/StageCards.tsx'))
  })

  it('has no double-encoded UTF-8 anywhere under src/', () => {
    const bad: string[] = []
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      const m = MOJIBAKE.exec(text)
      if (!m) continue
      bad.push(`${path.relative(SRC, f)}:${text.slice(0, m.index).split('\n').length}`)
    }
    expect(bad).toEqual([])
  })
})
