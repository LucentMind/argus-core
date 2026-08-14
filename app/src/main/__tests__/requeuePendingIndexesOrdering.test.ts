import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// `index.ts` imports `electron` at module scope, so it cannot be `import`ed into a Vitest test
// (see invokeScrubsIpcWrapper.test.ts for the same constraint on preload/index.ts) — this test
// reads it as source text instead, following routinesReconcileOrdering.test.ts's idiom.
const SRC = path.resolve(__dirname, '..')
const indexSrc = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8')

describe('requeuePendingIndexes runs before any evidence IPC handler is registered', () => {
  // A crash mid-index leaves rows stuck at 'pending'/'indexing'. requeuePendingIndexes() walks
  // those rows and re-enqueues them on the freshly constructed ingest queue. registerIpc()'s
  // body is synchronous and the call sits ahead of every ipcMain.handle(IPC.evidence*, ...)
  // registration, so no user-triggered ingest (drag-drop, paste, ...) can reach the queue before
  // the crash-recovery pass has already claimed the stuck rows. Nothing else pins this ordering:
  // index.ts imports `electron` at module scope and is not exercised by any runtime test, so
  // moving the call after the evidence handlers — or deleting it outright — compiles clean and
  // turns nothing else red. This test exists to catch exactly that reordering (or deletion).
  it('re-queues stranded indexing before evidence:ingest can start a new one', () => {
    const requeueMarker = 'requeuePendingIndexes(db, argusHome, ingestQueue)'
    const evidenceIngestMarker = 'ipcMain.handle(IPC.evidenceIngest,'

    // Guard against a vacuous pass: if either marker stops appearing at all — the requeue call
    // is deleted outright, or the handler is renamed — indexOf silently returns -1 for both,
    // -1 < -1 is false, and a naive ordering assertion would pass on a test that no longer
    // guards anything. Fail loudly instead, with a message that says which piece went missing.
    expect(
      indexSrc.includes(requeueMarker),
      `expected to find "${requeueMarker}" in main/index.ts. If it was renamed or removed, this ` +
        'test can no longer verify that stranded indexing is re-queued before evidence:ingest is ' +
        'registered — rows stuck at pending/indexing after a crash would then silently stay ' +
        'unsearchable until something else happened to re-touch them. Update this test alongside ' +
        'whatever renamed it.'
    ).toBe(true)
    expect(
      indexSrc.includes(evidenceIngestMarker),
      `expected to find "${evidenceIngestMarker}" in main/index.ts. If it was renamed, this test ` +
        'can no longer verify the requeue-before-ingest-handler ordering it exists to guard.'
    ).toBe(true)

    const requeueIndex = indexSrc.indexOf(requeueMarker)
    const evidenceIngestIndex = indexSrc.indexOf(evidenceIngestMarker)

    expect(
      requeueIndex,
      'requeuePendingIndexes(db, argusHome, ingestQueue) must be called BEFORE ' +
        'ipcMain.handle(IPC.evidenceIngest, ...) is registered. registerIpc() is synchronous, so ' +
        'this ordering is what guarantees no user-triggered ingest can enqueue new work on the ' +
        'queue before the crash-recovery pass has already re-queued whatever was stranded. Moving ' +
        'the requeue call after the evidence handlers (or deleting it) would let a user-triggered ' +
        'ingest race — or entirely outrun — the recovery pass. Move the requeue call back above ' +
        'the evidence IPC handlers.'
    ).toBeLessThan(evidenceIngestIndex)
  })
})
