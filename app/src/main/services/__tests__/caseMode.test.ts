import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase, getCase, setCaseMode } from '../caseService'
import { caseDir } from '../paths'
import { createSession, listSessions, sessionMode } from '../agent/sessionStore'
import type { SessionProvider } from '../agent/sessionStore'

let db: DatabaseSync
let home: string

const PROVIDER: SessionProvider = { driverKind: 'claude-agent-sdk', instanceId: null, model: null }

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-casemode-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
})

describe('case-level mode', () => {
  it('defaults a new case to investigation', () => {
    expect(getCase(db, 'c1')?.activeMode).toBe('investigation')
  })

  it('creates a session bound to the mode when none exists', async () => {
    const { sessionId } = await setCaseMode(db, home, 'c1', 'review', PROVIDER)
    expect(getCase(db, 'c1')?.activeMode).toBe('review')
    expect(sessionMode(db, sessionId)).toBe('review')
  })

  it("reuses that mode's most recent session instead of creating another", async () => {
    const first = (await setCaseMode(db, home, 'c1', 'review', PROVIDER)).sessionId
    await setCaseMode(db, home, 'c1', 'investigation', PROVIDER)
    const again = (await setCaseMode(db, home, 'c1', 'review', PROVIDER)).sessionId
    expect(again).toBe(first)
  })

  it("leaves the other mode's chats intact when switching back", async () => {
    const inv = listSessions(db, 'c1')[0]
    await setCaseMode(db, home, 'c1', 'review', PROVIDER)
    const back = await setCaseMode(db, home, 'c1', 'investigation', PROVIDER)
    expect(back.sessionId).toBe(inv.id)
    expect(sessionMode(db, inv.id)).toBe('investigation')
  })

  it('passes the given provider through to the freshly created session', async () => {
    const { sessionId } = await setCaseMode(db, home, 'c1', 'review', {
      driverKind: 'github-copilot',
      instanceId: 'copilot-1',
      model: 'auto'
    })
    const list = listSessions(db, 'c1')
    const created = list.find((s) => s.id === sessionId)!
    expect(created).toMatchObject({
      driverKind: 'github-copilot',
      instanceId: 'copilot-1',
      model: 'auto',
      mode: 'review'
    })
  })

  it('mirrors activeMode into case.json', async () => {
    await setCaseMode(db, home, 'c1', 'review', PROVIDER)
    const onDisk = JSON.parse(fs.readFileSync(path.join(caseDir(home, 'c1'), 'case.json'), 'utf8'))
    expect(onDisk.activeMode).toBe('review')
  })

  it('rebuilds from the DB record when case.json is corrupt, instead of dropping fields', async () => {
    const file = path.join(caseDir(home, 'c1'), 'case.json')
    fs.writeFileSync(file, '{ not valid json')

    const { sessionId } = await setCaseMode(db, home, 'c1', 'review', PROVIDER)
    expect(sessionMode(db, sessionId)).toBe('review')

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk.title).toBe('Case 1') // survived the corrupt-file fallback
    expect(onDisk.activeMode).toBe('review')
  })

  it('rejects an unknown mode', async () => {
    await expect(setCaseMode(db, home, 'c1', 'bogus' as never, PROVIDER)).rejects.toThrow(
      /unknown mode/i
    )
  })

  it('throws on an unknown case', async () => {
    await expect(setCaseMode(db, home, 'nope', 'review', PROVIDER)).rejects.toThrow(/unknown case/i)
  })
})

describe('new sessions bind to the case mode (IMPORTANT 1)', () => {
  it('a session created directly while the case is in review mode is bound to review, mirroring the sessions:create IPC handler', async () => {
    await setCaseMode(db, home, 'c1', 'review', PROVIDER)
    // Mirrors main/index.ts's sessions:create handler:
    // createSession(db, caseSlug, { ...newSessionProvider(), mode: getCase(db, caseSlug)?.activeMode })
    const s = createSession(db, 'c1', { ...PROVIDER, mode: getCase(db, 'c1')?.activeMode })
    expect(sessionMode(db, s.id)).toBe('review')
  })

  it("listSessions' auto-create path binds to the case's mode when the caller threads it through, mirroring the sessions:list IPC handler", () => {
    createCase(db, home, { slug: 'c2', title: 'Case 2' })
    db.prepare(`UPDATE cases SET active_mode = 'review' WHERE slug = 'c2'`).run()
    // Mirrors main/index.ts's sessions:list handler:
    // listSessions(db, caseSlug, newSessionProvider(), getCase(db, caseSlug)?.activeMode)
    const sessions = listSessions(db, 'c2', PROVIDER, getCase(db, 'c2')?.activeMode)
    expect(sessions).toHaveLength(1)
    expect(sessionMode(db, sessions[0].id)).toBe('review')
  })
})
