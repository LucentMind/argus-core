import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc'

/**
 * `main/index.ts` imports `electron` at module scope and cannot be imported into Vitest, so the
 * handler bodies are read as source text — the convention this directory already follows (see
 * caseArchiveIpc.test.ts and routinesIpc.test.ts, which say the same thing at length).
 *
 * SOURCE TEXT IS A WEAK ASSERTION, so this file asserts exactly one wiring fact and nothing
 * more. The behaviour either side of it is tested for real elsewhere:
 *   - that a moved ticket is DETECTED and rewrites the binding → services/__tests__/jiraCases.test.ts
 *     ("summary.rebound", plus the migration of evidence to the new key)
 *   - that `cases:changed` makes the renderer refetch and relabel → App.tsx's subscription, and
 *     components/__tests__/CaseCard.content.test.tsx for what it then draws
 *
 * What is only assertable here is the join between them: a rebound refresh has to tell the
 * renderer, or every surface that names the case goes on naming the ticket it used to be.
 */
const MAIN = path.resolve(__dirname, '..')
const indexSrc = fs.readFileSync(path.join(MAIN, 'index.ts'), 'utf8')

/** The handler body for `channel`, bounded by the NEXT `ipcMain.handle(`. */
function handlerBody(channelExpr: string): string {
  const start = indexSrc.indexOf(`ipcMain.handle(${channelExpr}`)
  expect(start, `${channelExpr} handler not found — renamed?`).toBeGreaterThan(-1)
  const next = indexSrc.indexOf('ipcMain.handle(', start + 1)
  return indexSrc.slice(start, next === -1 ? undefined : next)
}

describe('jira:refresh-case tells every window when the ticket moved', () => {
  it('the channels are real, distinct strings (guards a vacuous pass below)', () => {
    expect(IPC.jiraRefreshCase).toBe('jira:refresh-case')
    expect(IPC.casesChanged).toBe('cases:changed')
  })

  it('broadcasts cases:changed from the refresh handler, guarded on rebound', () => {
    const body = handlerBody('IPC.jiraRefreshCase')
    expect(body).toContain('broadcast(IPC.casesChanged')
    // Guarded, not unconditional: an ordinary refresh changes evidence, not the case row, and
    // making every poll refetch the whole cases list in every window is a different bug.
    expect(body).toMatch(/if\s*\(summary\.rebound\)\s*broadcast\(IPC\.casesChanged/)
  })
})
