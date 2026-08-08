import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// `index.ts` imports `electron` at module scope, so it cannot be `import`ed into a Vitest test
// (see invokeScrubsIpcWrapper.test.ts for the same constraint on preload/index.ts) — this test
// reads it as source text instead, following routinesReconcileOrdering.test.ts's idiom.
const SRC = path.resolve(__dirname, '..')
const indexSrc = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8')

describe('before-quit stops the live routine run', () => {
  // A run left `running` at quit used to sit that way, rendered as executing since last week,
  // until the NEXT launch's reconcileInterruptedRuns backstop finally closed it out.
  // RoutinesService.stopForQuit() closes it right away instead — this only pins that the
  // registered `before-quit` handler actually calls it; the behaviour itself is covered by
  // services/routines/__tests__/service.test.ts's `stopForQuit` describe block, which can run
  // the real service without booting Electron.
  it('registers a before-quit handler that calls routinesServiceHandle.stopForQuit()', () => {
    const beforeQuitMarker = "app.on('before-quit'"
    const stopForQuitMarker = 'routinesServiceHandle?.stopForQuit()'

    expect(
      indexSrc.includes(beforeQuitMarker),
      `expected to find "${beforeQuitMarker}" in main/index.ts. If the handler was renamed or ` +
        'restructured, this test can no longer verify that quit stops the live routine run.'
    ).toBe(true)
    expect(
      indexSrc.includes(stopForQuitMarker),
      `expected to find "${stopForQuitMarker}" in main/index.ts. If it was renamed or removed, ` +
        'a routine still running at quit would once again sit `running` in the database until ' +
        'the next launch reconciles it instead of being closed out right away.'
    ).toBe(true)

    // The call must actually be INSIDE the before-quit handler, not merely present somewhere
    // LATER in the file — a bare `indexOf(...) > indexOf(...)` ordering check would pass for
    // that too, since anything textually after the handler satisfies "greater than" without
    // ever being inside it. Bounded against the START of the NEXT top-level `app.on(...)`
    // registration instead (there is exactly one other in this file, 'window-all-closed', and it
    // is the statement immediately following the before-quit handler's closing brace) — a
    // stopForQuit call sitting between the two markers cannot be anywhere but inside this
    // handler's body.
    const nextHandlerMarker = "app.on('window-all-closed'"
    expect(
      indexSrc.includes(nextHandlerMarker),
      `expected to find "${nextHandlerMarker}" in main/index.ts — the marker this test uses to ` +
        'bound the end of the before-quit handler. If it was renamed, use whatever now follows ' +
        'before-quit instead.'
    ).toBe(true)

    const beforeQuitIndex = indexSrc.indexOf(beforeQuitMarker)
    const stopForQuitIndex = indexSrc.indexOf(stopForQuitMarker)
    const nextHandlerIndex = indexSrc.indexOf(nextHandlerMarker)
    expect(
      stopForQuitIndex,
      'routinesServiceHandle?.stopForQuit() must be called from WITHIN the before-quit handler, ' +
        'not merely present later in the file.'
    ).toBeGreaterThan(beforeQuitIndex)
    expect(
      stopForQuitIndex,
      'routinesServiceHandle?.stopForQuit() appears AFTER the before-quit handler has already ' +
        'closed (it comes at or past the next app.on(...) registration) — it must be called from ' +
        'inside the handler body, not after it.'
    ).toBeLessThan(nextHandlerIndex)
  })

  it('publishes routinesServiceHandle right after RoutinesService is constructed', () => {
    // before-quit lives at module scope and cannot see registerIpc()'s local `routinesService`
    // const directly — same reason routineStore/routineScheduler are published the same way.
    const publishMarker = 'routinesServiceHandle = routinesService'
    expect(
      indexSrc.includes(publishMarker),
      `expected to find "${publishMarker}" in main/index.ts. Without it, before-quit's ` +
        'routinesServiceHandle stays null forever and stopForQuit() is never actually called.'
    ).toBe(true)
  })
})
