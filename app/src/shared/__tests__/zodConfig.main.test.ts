import { afterAll, expect, test } from 'vitest'
import { z } from '../zodConfig'

// Control half of the pair — see zodConfig.renderer.test.ts for the other half.
// Without it, "the probe did not run" proves nothing: `allowsEval` is memoised, so a
// test asserting the probe was skipped passes vacuously if anything resolved it first.
// This file runs in the default `node` environment, where `window` is undefined, so
// the barrel must NOT set `jitless` and the probe must still fire.

// afterAll for symmetry with the renderer half, where clearing between tests would
// disarm the very thing under test.
afterAll(() => {
  delete z.config().jitless
})

test('main keeps the JIT: no window, so jitless is never set', () => {
  expect(z.config().jitless).toBeUndefined()
})

test('main actually probes: constructing an object schema calls new Function', () => {
  const original = globalThis.Function
  let probed = false
  // Stand in for a strict CSP: record the attempt, then throw the way the browser does.
  // @ts-expect-error swapping the Function global for a stub
  globalThis.Function = function StubFunction(): never {
    probed = true
    throw new EvalError('blocked by stub, standing in for script-src')
  }
  try {
    // The probe fires at CONSTRUCTION, not parse: $ZodObject evaluates
    // `jit && allowsEval.value` while building the schema.
    z.looseObject({ a: z.string() })
  } finally {
    globalThis.Function = original
  }
  expect(probed).toBe(true)
})
