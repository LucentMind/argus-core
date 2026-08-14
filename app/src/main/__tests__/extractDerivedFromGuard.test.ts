import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// `index.ts` imports `electron` at module scope, so it cannot be `import`ed into a Vitest test
// (see invokeScrubsIpcWrapper.test.ts for the same constraint on preload/index.ts) — this test
// reads it as source text instead, following routinesReconcileOrdering.test.ts's idiom.
const SRC = path.resolve(__dirname, '..')
const indexSrc = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8')

describe("the ingest queue's extract callback skips derived rows", () => {
  // ingestDerived inserts derived text with artifact_type 'text' and enqueues it with
  // index: true. The queue indexes it, then runs its extraction phase, which calls
  // extractDerivedText, which calls ingestDerived again on the row it just wrote — without
  // this guard that recurses forever, one new derived file per pass. It is latent only
  // because no shipped pack currently declares a `text` detector with an extract command; a
  // pack that does would recurse the moment it is installed. Deleting this one line compiles
  // clean and turns nothing else red — index.ts imports `electron` at module scope and is not
  // exercised by any runtime test — so this test exists to catch exactly that deletion.
  it('returns false before extracting a row that carries meta.derivedFrom', () => {
    const guardMarker = 'rec.meta.derivedFrom !== undefined) return false'
    const extractMarker = 'extract: async (evidenceId) => {'

    expect(
      indexSrc.includes(extractMarker),
      `expected to find "${extractMarker}" in main/index.ts — the queue's extract callback. If ` +
        'it was restructured, this test can no longer verify the recursion guard sits inside it.'
    ).toBe(true)
    expect(
      indexSrc.includes(guardMarker),
      `expected to find "${guardMarker}" in main/index.ts. Without it, a pack declaring an ` +
        'extract command for the derived `text` artifact type would recurse forever: each pass ' +
        "ingestDerived()'s output re-enters extraction and produces one more derived file."
    ).toBe(true)

    // The guard must sit INSIDE the extract callback, not merely somewhere later in the file —
    // bounded against the next callback field, onItemProgress, the statement that immediately
    // follows the extract callback's closing brace.
    const nextFieldMarker = 'onItemProgress: (p) => broadcast(IPC.evidenceProgress, p)'
    expect(
      indexSrc.includes(nextFieldMarker),
      `expected to find "${nextFieldMarker}" in main/index.ts — the marker this test uses to ` +
        'bound the end of the extract callback. If it was renamed, use whatever now follows it.'
    ).toBe(true)

    const extractIndex = indexSrc.indexOf(extractMarker)
    const guardIndex = indexSrc.indexOf(guardMarker)
    const nextFieldIndex = indexSrc.indexOf(nextFieldMarker)

    expect(
      guardIndex,
      'the derivedFrom guard must be called from WITHIN the extract callback, not merely ' +
        'present later in the file.'
    ).toBeGreaterThan(extractIndex)
    expect(
      guardIndex,
      "the derivedFrom guard appears AFTER the extract callback has already closed — it must " +
        'be inside the callback body, not after it.'
    ).toBeLessThan(nextFieldIndex)
  })
})
