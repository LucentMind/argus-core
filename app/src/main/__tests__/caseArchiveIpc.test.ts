import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'

/**
 * `main/index.ts` and `preload/index.ts` both import `electron` at module scope, so neither can
 * be `import`ed into a Vitest test — see main/__tests__/routinesIpc.test.ts and
 * preload/__tests__/invokeScrubsIpcWrapper.test.ts, which read them as source text for exactly
 * this reason. The archive/restore/touch handlers are registered inline inside `registerIpc()`
 * like every other cases channel, so this file follows that established convention.
 *
 * SOURCE TEXT IS A WEAK ASSERTION and this file is deliberately kept to the wiring facts only.
 * The DECISIONS these handlers make are tested for real elsewhere:
 *   - what counts as live work → services/__tests__/caseLiveWork.test.ts
 *   - the refusal itself, and that a refused case is untouched → services/__tests__/caseArchive.test.ts
 * What is only assertable here is that index.ts actually binds them together.
 */
const MAIN = path.resolve(__dirname, '..')
const indexSrc = fs.readFileSync(path.join(MAIN, 'index.ts'), 'utf8')
const preloadSrc = fs.readFileSync(path.join(MAIN, '..', 'preload', 'index.ts'), 'utf8')

/** The handler body for `channel`, bounded by the NEXT `ipcMain.handle(` rather than a fixed
 *  width — a magic width either truncates the body or spills into the next handler. */
function handlerBody(channelExpr: string): string {
  const start = indexSrc.indexOf(`ipcMain.handle(${channelExpr}`)
  expect(start).toBeGreaterThan(-1)
  const next = indexSrc.indexOf('ipcMain.handle(', start + 1)
  return indexSrc.slice(start, next === -1 ? undefined : next)
}

describe('the archive IPC channels', () => {
  it('are distinct, real channel strings (guards against a vacuous pass below)', () => {
    expect(IPC.casesArchive).toBe('cases:archive')
    expect(IPC.casesRestore).toBe('cases:restore')
    expect(IPC.casesArchiveSize).toBe('cases:archive-size')
    expect(IPC.casesTouchOpened).toBe('cases:touch-opened')
    expect(IPC.casesChanged).toBe('cases:changed')
    expect(
      new Set([
        IPC.casesArchive,
        IPC.casesRestore,
        IPC.casesArchiveSize,
        IPC.casesTouchOpened,
        IPC.casesDelete,
        IPC.casesChanged
      ]).size
    ).toBe(6)
  })
})

describe('main/index.ts wires the archive handlers', () => {
  it('registers all three channels', () => {
    for (const c of ['IPC.casesArchive', 'IPC.casesRestore', 'IPC.casesTouchOpened']) {
      expect(indexSrc).toMatch(new RegExp(`ipcMain\\.handle\\(\\s*${c.replace('.', '\\.')}`))
    }
  })

  it('sweeps stale staging directories before any archive/restore/import handler is registered', () => {
    // The whole "safe by construction" argument for the stale-staging fix (and the plan's exit
    // check #6) is that `sweepStaleStagingDirs` runs at startup, before `cases:archive`,
    // `cases:restore` or the bundle-import handler can create a NEW staging directory of their
    // own — otherwise the sweep could race a fresh one and delete live work. Source-position is
    // the only thing that can pin an ordering fact; nothing else in this file exercises it.
    const sweep = indexSrc.indexOf('sweepStaleStagingDirs(')
    const archive = indexSrc.indexOf('ipcMain.handle(IPC.casesArchive')
    const restore = indexSrc.indexOf('ipcMain.handle(IPC.casesRestore')
    const bundleImport = indexSrc.indexOf('ipcMain.handle(IPC.bundleImport')
    expect(sweep).toBeGreaterThan(-1)
    expect(archive).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(-1)
    expect(bundleImport).toBeGreaterThan(-1)
    expect(sweep).toBeLessThan(archive)
    expect(sweep).toBeLessThan(restore)
    expect(sweep).toBeLessThan(bundleImport)
  })

  it('the archive handler REFUSES live work rather than stopping it', () => {
    const body = handlerBody('IPC.casesArchive')
    expect(body).toContain('assertSlug(slug)')
    expect(body).toContain('archiveCase(')
    // The seam is supplied, and it is the real composite one — not a closure over the agent
    // session map alone, which cannot see a routine's background session (caseLiveWork.ts).
    expect(body).toContain('liveWorkReason:')
    expect(body).toContain('caseLiveWorkReason(')
    // `busyCaseSlugsOf`, never a bare map over states(): an entry survives the end of its turn,
    // so an unfiltered map refuses every case whose chat has ever been opened. Pinned as text
    // because this binding is the one thing caseLiveWork.test.ts cannot reach.
    expect(body).toContain('busyCaseSlugs: () => busyCaseSlugsOf(agentService!)')
    expect(body).not.toMatch(/states\(\)\.map/)
    // External processes spawned into the case dir are in the check too: neither
    // assertCaseWritable nor the freeze can see them.
    expect(body).toContain('openExternalApps:')
    expect(body).toContain('externalAppHost?.list(slug)')
    // The single most important negative: archiving must NOT stop the case's sessions the way
    // cases:delete does. Doing so would archive underneath work the user never abandoned.
    expect(body).not.toContain('stopAllForCase')
  })

  it('archive and restore announce the evidence mutation AND the case-row change', () => {
    // Archiving deletes EVERY evidence row for the case and restore puts them all back — the
    // largest evidence mutation in the app, next to `evidence:delete`, a single-row delete,
    // which already calls this. An archived case stays OPEN and viewable, so without these
    // every window keeps rendering rows whose files and rows are gone.
    for (const c of ['IPC.casesArchive', 'IPC.casesRestore']) {
      const body = handlerBody(c)
      expect(body).toContain('evidenceChangedB(slug)')
      expect(body).toContain('broadcast(IPC.casesChanged, slug)')
    }
    // Restore must not fire-and-forget its own result: it awaits, then announces, then returns.
    expect(handlerBody('IPC.casesRestore')).toMatch(/const res = await restoreCase\(/)
  })

  it('the restore handler passes the SHARED ingest queue, not a fresh one', () => {
    const body = handlerBody('IPC.casesRestore')
    expect(body).toContain('assertSlug(slug)')
    expect(body).toMatch(/restoreCase\(\s*db,\s*argusHome,\s*slug,\s*ingestQueue\s*\)/)
    expect(body).not.toMatch(/new IngestQueue|createImmediateQueue/)
  })

  it('the touch-opened handler stays fire-and-forget', () => {
    const body = handlerBody('IPC.casesTouchOpened')
    expect(body).toContain('touchCaseOpened(db, slug)')
    // No dialog, no broadcast, nothing that could turn a silent no-op into a user-facing error.
    expect(body).not.toMatch(/dialog\.|broadcast\(/)
  })

  it('cases:delete forwards its options and still defaults to KEEPING the archive', () => {
    const body = handlerBody('IPC.casesDelete')
    expect(body).toMatch(/opts\?:\s*\{\s*deleteArchive\?:\s*boolean\s*\}/)
    expect(body).toContain('deleteCase(db, argusHome, slug, opts ?? {})')
    // `opts ?? {}`, never `opts!` or a literal `{ deleteArchive: true }`: every existing caller
    // passes nothing and must keep its bundle.
    expect(body).not.toMatch(/deleteArchive:\s*true/)
  })

  it('cases:delete checks the frozen rule BEFORE it stops sessions or unwatches', () => {
    const body = handlerBody('IPC.casesDelete')
    const guard = body.indexOf('assertCaseDeletable(slug)')
    const stop = body.indexOf('stopAllForCase(slug)')
    const unwatch = body.indexOf('caseWatch.unwatch(slug)')
    expect(guard).toBeGreaterThan(-1)
    // Both side effects are irreversible; a refusal after them leaves the user with dead chats,
    // no watcher, and no delete. The behavioural proof is in services/__tests__/caseService.test.ts.
    expect(guard).toBeLessThan(stop)
    expect(guard).toBeLessThan(unwatch)
    // ONE definition of the rule: the handler must not re-inline `isCaseFrozen` + its message.
    // Bounded at `deleteCase(` on purpose — handlerBody runs to the NEXT ipcMain.handle( and so
    // swallows the archive block's leading comment, which makes the tail a bad place for any
    // negative assertion.
    expect(body.slice(0, body.indexOf('deleteCase('))).not.toContain('isCaseFrozen')
  })

  it('cases:archive-size reads the SAME bundle path and helper the deletion audit does', () => {
    // Spec §7's "states the bundle's actual size" is only true if it is the size of the file the
    // delete would actually remove. `deleteCase` derives its audit's `archiveBytes` from
    // `bundleBytes(caseArchivePath(argusHome, slug))`; a second derivation here — a stored
    // column, a `rec.archivePath` read, a fresh statSync — is a second representation of one
    // fact, and this repo's recurring defect is exactly those two drifting apart.
    const body = handlerBody('IPC.casesArchiveSize')
    expect(body).toContain('assertSlug(slug)')
    expect(body).toContain('bundleBytes(caseArchivePath(argusHome, slug))')
    expect(body).not.toMatch(/statSync|getCase\(|archivePath/)
  })

  it('cases:delete announces the case-row change to every window', () => {
    // The delete dialog's `onDeleted()` callback reaches only the window that opened it.
    expect(handlerBody('IPC.casesDelete')).toContain('broadcast(IPC.casesChanged, slug)')
  })
})

describe('preload/index.ts bridges them', () => {
  it('exposes archive, restore and touchOpened on window.argus.cases', () => {
    // Line-bounded (no `s` flag, no newline in `[^\n]*`): a dot-all `.*` here would happily
    // span from one method's name to a DIFFERENT method's invoke call further down the file.
    expect(preloadSrc).toMatch(/archive: \(slug: string\)[^\n]*invoke\(IPC\.casesArchive, slug\)/)
    expect(preloadSrc).toMatch(/restore: \(slug: string\)[^\n]*invoke\(IPC\.casesRestore, slug\)/)
    // touchOpened's body wraps onto its own line (prettier), so the two halves are asserted
    // separately rather than with a `[^\n]*` bridge that cannot cross the newline.
    expect(preloadSrc).toMatch(/touchOpened: \(slug: string\): Promise<void> =>/)
    expect(preloadSrc).toMatch(/^\s*invoke\(IPC\.casesTouchOpened, slug\)/m)
  })

  it('passes delete options through instead of dropping them at the bridge', () => {
    expect(preloadSrc).toMatch(/invoke\(IPC\.casesDelete, slug, opts\)/)
  })

  it('exposes archiveSize, the number the delete confirmation names', () => {
    expect(preloadSrc).toMatch(
      /archiveSize: \(slug: string\): Promise<number \| null> =>\s*\n?\s*invoke\(IPC\.casesArchiveSize, slug\)/
    )
  })

  it('makes touchOpened genuinely fire-and-forget instead of only claiming to be', () => {
    // The handler's assertSlug REJECTS on a malformed slug, so returning the raw invoke promise
    // hands `void window.argus.cases.touchOpened(slug)` an unhandled rejection.
    expect(preloadSrc).toMatch(/invoke\(IPC\.casesTouchOpened, slug\)\.catch\(\(\) => undefined\)/)
  })

  it('bridges the all-window cases:changed broadcast the way it bridges evidence:changed', () => {
    expect(preloadSrc).toMatch(/ipcRenderer\.on\(IPC\.casesChanged, listener\)/)
    expect(preloadSrc).toMatch(/removeListener\(IPC\.casesChanged, listener\)/)
  })
})
