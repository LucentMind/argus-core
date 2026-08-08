import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// `index.ts` imports `electron` at module scope, so it cannot be `import`ed into a Vitest test
// (see invokeScrubsIpcWrapper.test.ts for the same constraint on preload/index.ts) — this test
// reads it as source text instead, following that file's idiom.
const SRC = path.resolve(__dirname, '..')
const indexSrc = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8')

describe('reconcileInterruptedRuns runs before routinesRunNow is registered', () => {
  // reconcileInterruptedRuns() blanket-marks every run row still `status='running'` as failed.
  // That is only safe because `registerIpc()`'s body is synchronous and the reconcile call sits
  // ahead of `ipcMain.handle(IPC.routinesRunNow, ...)` — the ONLY path that can start a run — so
  // no run of this process can possibly be in flight yet when reconcile runs; every `running` row
  // it finds must be a leftover from a previous, now-dead process.
  //
  // If a future edit moved (or deleted) the reconcile call so it landed after routinesRunNow is
  // registered, a run started immediately after boot could still be `running` when reconcile
  // fires, and reconcile would mark that LIVE, legitimately in-flight run as failed — corrupting
  // its record while it is still executing. Nothing else pins this ordering: index.ts imports
  // `electron` at module scope and is not exercised by any runtime test, so a reordering compiles
  // clean and turns no other test red. This test exists to catch exactly that reordering.
  it('reconciles stranded runs before the run-now handler can start a new one', () => {
    const reconcileMarker = 'reconcileInterruptedRuns('
    const runNowMarker = 'IPC.routinesRunNow'

    // Guard against a vacuous pass: if either marker stops appearing at all — the reconcile call
    // is deleted outright, or routinesRunNow is renamed — indexOf silently returns -1 for both,
    // -1 < -1 is false, and a naive ordering assertion would pass on a test that no longer
    // guards anything. Fail loudly instead, with a message that says which piece went missing.
    expect(
      indexSrc.includes(reconcileMarker),
      `expected to find a "${reconcileMarker}" call in main/index.ts. If it was renamed or ` +
        'removed, this test can no longer verify that stranded runs are reconciled before ' +
        'routinesRunNow is registered — a run started right after boot could then be marked ' +
        'failed while still in flight. Update this test alongside whatever renamed it.'
    ).toBe(true)
    expect(
      indexSrc.includes(runNowMarker),
      `expected to find "${runNowMarker}" in main/index.ts. If it was renamed, this test can no ` +
        'longer verify the reconcile-before-run-handler ordering it exists to guard.'
    ).toBe(true)

    const reconcileIndex = indexSrc.indexOf(reconcileMarker)
    const runNowIndex = indexSrc.indexOf(runNowMarker)

    expect(
      reconcileIndex,
      'reconcileInterruptedRuns(db) must be called BEFORE ipcMain.handle(IPC.routinesRunNow, ...) ' +
        'is registered. registerIpc() is synchronous, so this ordering is what guarantees no run ' +
        "can be in flight when reconcile blanket-marks status='running' rows as failed. Moving " +
        'the reconcile call after the routinesRunNow registration would let a run started right ' +
        'after boot be falsely marked failed while it is still legitimately executing — corrupting ' +
        "a live run's record. Move the reconcile call back above the routinesRunNow handler."
    ).toBeLessThan(runNowIndex)
  })
})

describe('the scheduler starts after reconcile and after the IPC handlers', () => {
  it('starts only once the host is fully built', () => {
    const startMarker = 'routineScheduler.start()'
    const reconcileMarker = 'reconcileInterruptedRuns('
    const runNowMarker = 'IPC.routinesRunNow'

    expect(
      indexSrc.includes(startMarker),
      `expected to find "${startMarker}" in main/index.ts. If the scheduler is no longer ` +
        'started there, nothing fires a scheduled routine and this test can no longer verify ' +
        'the ordering it exists to guard.'
    ).toBe(true)
    expect(
      indexSrc.includes(reconcileMarker),
      `expected to find "${reconcileMarker}" in main/index.ts. If it was renamed or removed, ` +
        'this test can no longer verify that the scheduler starts after reconciling stranded ' +
        "runs — a launch catch-up run's row could be blanket-marked failed by the reconcile " +
        'that follows. Update this test alongside whatever renamed it.'
    ).toBe(true)
    expect(
      indexSrc.includes(runNowMarker),
      `expected to find "${runNowMarker}" in main/index.ts. If it was renamed, this test can ` +
        'no longer verify that the scheduler starts only after the run-now handler is registered ' +
        '— a run beginning on the first synchronous tick would otherwise run against a ' +
        'half-registered host.'
    ).toBe(true)

    const start = indexSrc.indexOf(startMarker)
    // start() runs its first tick SYNCHRONOUSLY — that tick is the launch catch-up, so a run
    // can begin on that very line. Ahead of the reconcile, its fresh `running` row would be
    // blanket-marked failed by the reconcile that follows. Ahead of the handlers, it would run
    // against a half-registered host.
    expect(
      start,
      'routineScheduler.start() must come AFTER reconcileInterruptedRuns(db): its first tick is ' +
        "synchronous, so a catch-up run's row would otherwise be rewritten as failed underneath it."
    ).toBeGreaterThan(indexSrc.indexOf(reconcileMarker))
    expect(
      start,
      'routineScheduler.start() must come AFTER the ipcMain.handle(IPC.routinesRunNow, ...) ' +
        'registration, so a run beginning on the first synchronous tick meets a fully built host.'
    ).toBeGreaterThan(indexSrc.indexOf(runNowMarker))
  })

  it('stops the scheduler on quit', () => {
    // A poll left running past quit keeps ticking against a closing database.
    expect(indexSrc).toContain('routineScheduler?.stop()')
  })
})
