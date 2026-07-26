import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PROMPT_ENTRIES } from '../registry'
import { DEFERRED_PROMPTS } from '../deferred'

const REPO_ROOT = path.resolve(__dirname, '../../../../../..')

/** Files known to carry model-facing text. A new prompt-bearing file must be added here. */
const SCANNED = [
  'app/src/shared/modes.ts',
  'app/src/main/services/agent/persona.ts',
  'app/src/main/services/agent/skillIndex.ts',
  'app/src/main/services/agent/session.ts',
  'app/src/main/services/agent/nativeTools.ts',
  'app/src/main/services/distill/caseDistillContract.ts',
  'app/src/main/services/distill/contract.ts',
  'app/src/main/services/refSync/distill.ts',
  'app/src/main/services/caseService.ts',
  'app/src/main/services/jiraCases.ts'
]

/** Long enough to be prose rather than a key, a path, or a short label. */
const MIN_CHARS = 120

/** Reads like instruction text written for a model, not like code or UI copy. */
const PROMPTY =
  /\b(you are|you must|your task|do not|never |always |respond|return only|output|rules:|guidelines|cite|citation|follow every|exactly one|fenced|json block|use this tool|treat them)\b/i

/**
 * Strip comments before scanning for literals. This is a scanning heuristic, not a parser:
 * persona.ts's doc comment for DIAGRAM_FRAGMENT reads "intercepts ```mermaid fences" — an
 * odd/unbalanced run of backticks inside a `/* *\/` block comment — which desyncs the
 * balanced-backtick regex below and makes it misidentify where the next real template
 * literal starts. Stripping comments first avoids that whole class of false match. Verified
 * safe for every SCANNED file: none of them put `/*`, `*\/`, `//`, or a URL inside a string or
 * template literal, so this can't accidentally eat real prompt content.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function literalsIn(rawSrc: string): string[] {
  const src = stripComments(rawSrc)
  const out: string[] = []
  // Template literals and long single/double-quoted strings.
  const re = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.){80,}'|"(?:[^"\\\n]|\\.){80,}"/g
  for (const m of src.matchAll(re)) {
    // Normalize CRLF -> LF: these files are checked out with CRLF line terminators, but
    // esbuild/vitest normalizes template literals to LF when compiling the module. Without
    // this, a genuinely-registered multi-line literal read raw from disk would never match
    // its own (LF-only) runtime value and would be misreported as unregistered.
    const body = m[0].slice(1, -1).replace(/\r\n/g, '\n')
    if (body.length < MIN_CHARS) continue
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|PRAGMA|WITH)\b/i.test(body)) continue
    if (!PROMPTY.test(body)) continue
    out.push(body)
  }
  return out
}

/** Every registry default, plus every deferred literal's file, as the coverage universe. */
const registered = PROMPT_ENTRIES.filter((e) => e.category !== 'external').map((e) => e.default())
const deferredFiles = new Set(DEFERRED_PROMPTS.map((d) => d.file))

/**
 * Scan every SCANNED file once and bucket each qualifying literal as registered, deferred, or
 * unexplained. Both tests below read off this single pass — the failure list and the per-file
 * tally can never come from different scans (e.g. one filtering differently than the other).
 */
function scanAll(): { unexplained: string[]; perFile: Map<string, number> } {
  const unexplained: string[] = []
  const perFile = new Map<string, number>()
  for (const f of SCANNED) {
    const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')
    for (const lit of literalsIn(src)) {
      // Registered: some entry's default contains (or equals) this literal. `contains`
      // rather than `equals` because an extracted constant may be a slice of the literal
      // the scanner sees (escapes, interpolation).
      const isRegistered = registered.some(
        (r) => r === lit || r.includes(lit.slice(0, 60)) || lit.includes(r.slice(0, 60))
      )
      if (isRegistered) continue
      if (deferredFiles.has(f)) {
        perFile.set(f, (perFile.get(f) ?? 0) + 1)
        continue
      }
      unexplained.push(`${f}: ${lit.replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  return { unexplained, perFile }
}

/** file -> number of literals that are neither registered nor caught by the unexplained list
 *  above (i.e. the deferred-file literals) — the scan's raw tally. */
function perFileCounts(): Map<string, number> {
  return scanAll().perFile
}

describe('prompt coverage', () => {
  it('every scanned file exists', () => {
    for (const f of SCANNED) expect(fs.existsSync(path.join(REPO_ROOT, f)), f).toBe(true)
  })

  it('every long model-facing literal is registered or explicitly deferred', () => {
    const { unexplained } = scanAll()
    expect(unexplained, `unregistered model-facing text:\n${unexplained.join('\n')}`).toEqual([])
  })

  it('every deferred entry names a file that exists and carries a reason and a plan', () => {
    for (const d of DEFERRED_PROMPTS) {
      expect(fs.existsSync(path.join(REPO_ROOT, d.file)), d.file).toBe(true)
      expect(d.reason.length, d.symbol).toBeGreaterThan(20)
      expect(d.plannedIn.length, d.symbol).toBeGreaterThan(0)
    }
  })

  it('deferred entries do not shadow a whole file that is fully registered', () => {
    // Guards the escape hatch: listing a file in DEFERRED_PROMPTS exempts every literal in it,
    // so a file whose prompts are all registered must not also be deferred.
    const fullyRegistered = ['app/src/shared/modes.ts', 'app/src/main/services/agent/persona.ts']
    for (const f of fullyRegistered) expect(deferredFiles.has(f), f).toBe(false)
  })

  it('a deferred file contains exactly the number of unregistered literals it declares', () => {
    const expected = new Map<string, number>()
    for (const d of DEFERRED_PROMPTS) expected.set(d.file, (expected.get(d.file) ?? 0) + d.count)
    const actual = perFileCounts()
    for (const [file, want] of expected) {
      const got = actual.get(file) ?? 0
      expect(got, `${file}: declared ${want} unregistered literal(s), found ${got}`).toBe(want)
    }
  })
})
