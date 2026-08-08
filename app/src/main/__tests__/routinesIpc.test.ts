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
    const start = indexSrc.indexOf('ipcMain.handle(IPC.routinesAcceptItem')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 300)
    expect(body).toContain('routinesService.acceptItem(')
    expect(body).toContain('routinesService.payload()')
  })

  it('rejects a dismiss with no resolution rather than closing a case unexplained', () => {
    // The IPC step-1 test this file replaces would call the handler with `undefined` and expect
    // a rejection; ipcMain.handle handlers can't be invoked without electron, so this asserts the
    // guard exists in source instead, and asserts it runs BEFORE dismissItem is ever called.
    const start = indexSrc.search(/ipcMain\.handle\(\s*IPC\.routinesDismissItem/)
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 500)
    expect(body).toMatch(/if\s*\(\s*!resolution\s*\)\s*throw/)
    const guardIndex = body.search(/if\s*\(\s*!resolution\s*\)\s*throw/)
    const dismissCallIndex = body.indexOf('routinesService.dismissItem(')
    expect(dismissCallIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(dismissCallIndex)
    expect(body).toContain('routinesService.payload()')
  })
})

describe('the Jira scope resolver binding', () => {
  it('binds a ScopeResolver and passes it to the RoutinesService constructor', () => {
    expect(indexSrc).toMatch(/scopeResolver\s*:\s*ScopeResolver/)
    expect(indexSrc).toContain('scopeResolver')
    const ctorStart = indexSrc.indexOf('new RoutinesService({')
    expect(ctorStart).toBeGreaterThan(-1)
    const ctorBody = indexSrc.slice(ctorStart, ctorStart + 1200)
    expect(ctorBody).toMatch(/scopeResolver(,|\s*:\s*scopeResolver)/)
  })

  it('resolveJql uses an INCLUSIVE (>=) cursor boundary, not a strict >', () => {
    // Jira timestamps are not unique; a strict `>` would drop one of two tickets sharing a
    // minute, permanently and silently. items.ts removes the duplicate by key.
    const start = indexSrc.indexOf('async resolveJql(')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 600)
    expect(body).toContain('${cursorField} >= "')
    expect(body).not.toMatch(/\$\{cursorField\}\s*>\s*[^=]/)
  })

  it('ingestJiraItem checks findCaseByJiraKey before creating, so a routine adopts rather than duplicating', () => {
    const start = indexSrc.indexOf('async ingestJiraItem(')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 700)
    expect(body).toContain('findCaseByJiraKey(')
    expect(body).toContain('createFromTicket(')
    // The adopt branch must return before ever reaching createFromTicket.
    expect(body.indexOf('findCaseByJiraKey(')).toBeLessThan(body.indexOf('createFromTicket('))
  })
})

describe('preload exposes acceptItem/dismissItem over the wrapping invoke()', () => {
  it('routes both through invoke(IPC....), never ipcRenderer.invoke directly', () => {
    expect(preloadSrc).toContain('invoke(IPC.routinesAcceptItem')
    expect(preloadSrc).toContain('invoke(IPC.routinesDismissItem')
  })
})
