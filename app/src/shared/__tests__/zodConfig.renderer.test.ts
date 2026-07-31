// @vitest-environment jsdom
import { afterAll, expect, test } from 'vitest'
import { z } from '../zodConfig'

// The half that guards the fix. `window` exists here, so the barrel must set `jitless`
// and zod must never reach for `new Function` — which under the real windows'
// `script-src 'self'` is what produced a securitypolicyviolation on every page load.
// Its control is zodConfig.main.test.ts, which proves the probe still fires without a
// window; the memoised `allowsEval` makes a lone "did not probe" assertion vacuous.
// Separate file because vitest isolates the module graph per file, so `allowsEval` is
// unresolved when this runs.

// afterAll, not afterEach: the barrel sets `jitless` once at import, so clearing it
// between tests would leave every test after the first running unconfigured. Cleared at
// the end only so other files sharing this worker's globalThis see the default.
afterAll(() => {
  delete z.config().jitless
})

test('renderer opts out: window present, so jitless is set', () => {
  expect(z.config().jitless).toBe(true)
})

test('renderer never probes: constructing an object schema leaves Function untouched', () => {
  const original = globalThis.Function
  let probed = false
  let stack = ''
  // @ts-expect-error swapping the Function global for a stub
  globalThis.Function = function StubFunction(): never {
    probed = true
    stack = new Error().stack ?? ''
    throw new EvalError('the probe should have been short-circuited by jitless')
  }
  let parsed: unknown
  try {
    const schema = z.looseObject({ a: z.string() })
    parsed = schema.parse({ a: 'x' })
  } finally {
    globalThis.Function = original
  }
  // Assertions live OUTSIDE the stub window: vitest's own expect() machinery
  // compiles helpers with the Function constructor, which would otherwise trip
  // the stub and report a probe that zod never made.
  expect(probed, `Function called from:\n${stack}`).toBe(false)
  expect(parsed).toEqual({ a: 'x' })
})
