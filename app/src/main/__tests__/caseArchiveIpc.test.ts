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
    expect(IPC.casesTouchOpened).toBe('cases:touch-opened')
    expect(
      new Set([IPC.casesArchive, IPC.casesRestore, IPC.casesTouchOpened, IPC.casesDelete]).size
    ).toBe(4)
  })
})

describe('main/index.ts wires the archive handlers', () => {
  it('registers all three channels', () => {
    for (const c of ['IPC.casesArchive', 'IPC.casesRestore', 'IPC.casesTouchOpened']) {
      expect(indexSrc).toMatch(new RegExp(`ipcMain\\.handle\\(\\s*${c.replace('.', '\\.')}`))
    }
  })

  it('the archive handler REFUSES live work rather than stopping it', () => {
    const body = handlerBody('IPC.casesArchive')
    expect(body).toContain('assertSlug(slug)')
    expect(body).toContain('archiveCase(')
    // The seam is supplied, and it is the real composite one — not a closure over the agent
    // session map alone, which cannot see a routine's background session (caseLiveWork.ts).
    expect(body).toContain('hasLiveWork:')
    expect(body).toContain('caseHasLiveWork(')
    // The single most important negative: archiving must NOT stop the case's sessions the way
    // cases:delete does. Doing so would archive underneath work the user never abandoned.
    expect(body).not.toContain('stopAllForCase')
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
})

describe('preload/index.ts bridges them', () => {
  it('exposes archive, restore and touchOpened on window.argus.cases', () => {
    // Line-bounded (no `s` flag, no newline in `[^\n]*`): a dot-all `.*` here would happily
    // span from one method's name to a DIFFERENT method's invoke call further down the file.
    expect(preloadSrc).toMatch(/archive: \(slug: string\)[^\n]*invoke\(IPC\.casesArchive, slug\)/)
    expect(preloadSrc).toMatch(/restore: \(slug: string\)[^\n]*invoke\(IPC\.casesRestore, slug\)/)
    expect(preloadSrc).toMatch(
      /touchOpened: \(slug: string\)[^\n]*invoke\(IPC\.casesTouchOpened, slug\)/
    )
  })

  it('passes delete options through instead of dropping them at the bridge', () => {
    expect(preloadSrc).toMatch(/invoke\(IPC\.casesDelete, slug, opts\)/)
  })
})
