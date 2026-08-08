import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'

/**
 * `main/index.ts` imports `electron` at module scope, so it cannot be `import`ed into a Vitest
 * test (see routinesReconcileOrdering.test.ts for the same constraint, and
 * invokeScrubsIpcWrapper.test.ts for preload/index.ts's identical one) — this test reads it as
 * source text instead, following both of those files' idiom.
 *
 * The plan step that specced this file wrote its Step-1 test against a `registerRoutinesIpc()`
 * harness that returns a `Map` of handlers to invoke directly (mirroring
 * services/update/__tests__/updateIpc.test.ts's `registerUpdateIpc`). No such function exists for
 * routines: every routines channel — list/save/delete/run-now/mark-reviewed/mark-all-reviewed,
 * and now accept/dismiss — is registered inline inside `registerIpc()` in main/index.ts, the same
 * as every increment before this one (see `git log` on that block). Extracting a testable
 * registration module was out of scope for this task and would have meant refactoring five
 * already-shipped, already-live handlers alongside the two new ones. So this file follows the
 * REAL existing convention for asserting behaviour wired into `registerIpc()`: read the source and
 * check for the markers that prove the wiring is present and in the right shape, the same way
 * routinesReconcileOrdering.test.ts pins ordering it cannot invoke directly.
 *
 * The Jira half of `ScopeResolver` itself (JQL composition, the ORDER BY strip, adopt-vs-create)
 * no longer lives in this file's source-text blast radius at all — it was extracted to
 * `services/jiraScopeResolver.ts` (Task 12 review, Important 1) specifically so it could get real
 * behavioural coverage instead of regex-on-source-text. See
 * `services/__tests__/jiraScopeResolver.test.ts`. What remains testable only as source text here
 * is the thin Electron-adjacent binding: that `index.ts` actually calls the builder and wires its
 * result into `RoutinesService`.
 */
const SRC = path.resolve(__dirname, '..')
const indexSrc = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8')
const preloadSrc = fs.readFileSync(path.join(SRC, '..', 'preload', 'index.ts'), 'utf8')

describe('IPC.routinesAcceptItem / IPC.routinesDismissItem', () => {
  it('are distinct, real channel strings (guards against a vacuous pass below)', () => {
    expect(IPC.routinesAcceptItem).toBe('routines:accept-item')
    expect(IPC.routinesDismissItem).toBe('routines:dismiss-item')
    expect(IPC.routinesAcceptItem).not.toBe(IPC.routinesDismissItem)
  })
})

describe('main/index.ts registers the accept/dismiss handlers', () => {
  it('handles both channels', () => {
    expect(indexSrc).toContain(`ipcMain.handle(IPC.routinesAcceptItem`)
    // The dismiss registration wraps onto its own line (its handler signature is long), so this
    // channel is registered as `ipcMain.handle(\n    IPC.routinesDismissItem,` rather than on one
    // line like every other routines handler — match loosely across the wrap.
    expect(indexSrc).toMatch(/ipcMain\.handle\(\s*IPC\.routinesDismissItem/)
  })

  it('the accept handler reaches routinesService.acceptItem and returns the fresh payload', () => {
    // Bounded by the NEXT handler registration rather than a fixed character width — a magic
    // width risks either truncating the body or spilling into the next handler's source (the
    // latter happened here: a 300-char window used to reach past this handler's closing `})`
    // and into the dismiss handler below it).
    const start = indexSrc.indexOf('ipcMain.handle(IPC.routinesAcceptItem')
    expect(start).toBeGreaterThan(-1)
    const end = indexSrc.search(/ipcMain\.handle\(\s*IPC\.routinesDismissItem/)
    expect(end).toBeGreaterThan(start)
    const body = indexSrc.slice(start, end)
    expect(body).toContain('routinesService.acceptItem(')
    expect(body).toContain('routinesService.payload()')
  })

  it('rejects a dismiss with no resolution, or one that is not a real CaseResolution, rather than closing a case unexplained', () => {
    // The IPC step-1 test this file replaces would call the handler with `undefined` and expect
    // a rejection; ipcMain.handle handlers can't be invoked without electron, so this asserts the
    // guard exists in source instead, and asserts it runs BEFORE dismissItem is ever called.
    const start = indexSrc.search(/ipcMain\.handle\(\s*IPC\.routinesDismissItem/)
    expect(start).toBeGreaterThan(-1)
    // Bounded by the next distinct block (scheduling) rather than a fixed 500-char width, for the
    // same reason as the accept handler above.
    const end = indexSrc.indexOf('// Scheduling, and this is the only correct moment', start)
    expect(end).toBeGreaterThan(start)
    const body = indexSrc.slice(start, end)
    // Truthiness alone lets any non-empty string through IPC (untyped at runtime) — the guard
    // must also check CASE_RESOLUTIONS membership.
    expect(body).toMatch(
      /if\s*\(\s*!resolution\s*\|\|\s*!CASE_RESOLUTIONS\.includes\(resolution\)\s*\)/
    )
    const guardIndex = body.search(/if\s*\(\s*!resolution/)
    const dismissCallIndex = body.indexOf('routinesService.dismissItem(')
    expect(dismissCallIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(dismissCallIndex)
    expect(body).toContain('routinesService.payload()')
  })
})

describe('the Jira scope resolver binding', () => {
  it('builds the resolver via buildJiraScopeResolver and passes it to the RoutinesService constructor', () => {
    expect(indexSrc).toContain('buildJiraScopeResolver(')
    const ctorStart = indexSrc.indexOf('new RoutinesService({')
    expect(ctorStart).toBeGreaterThan(-1)
    const ctorBody = indexSrc.slice(ctorStart, ctorStart + 1200)
    expect(ctorBody).toMatch(/scopeResolver(,|\s*:\s*scopeResolver)/)
  })
})

describe('preload exposes acceptItem/dismissItem over the wrapping invoke()', () => {
  it('routes both through invoke(IPC....), never ipcRenderer.invoke directly', () => {
    expect(preloadSrc).toContain('invoke(IPC.routinesAcceptItem')
    expect(preloadSrc).toContain('invoke(IPC.routinesDismissItem')
  })
})
