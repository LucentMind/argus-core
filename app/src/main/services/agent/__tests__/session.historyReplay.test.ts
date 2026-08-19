import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createSession } from '../sessionStore'
import { createDetection } from '../../packs/detection'
import { caseDir } from '../../paths'
import { CaseSession, type SessionMirrorLike } from '../session'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'
import { PERMISSION_MODES } from '../../../../shared/settings'
import type { AgentDriver, DriverSession } from '../driver'
import type { AgentEvent } from '../../../../shared/agent-events'

/**
 * A driver that records what CaseSession actually handed the provider. The digest lives on
 * exactly this wire and nowhere else, so `sent` is the only place it may appear.
 */
function recordingDriver(): { driver: AgentDriver; sent: string[] } {
  const sent: string[] = []
  const driver: AgentDriver = {
    kind: 'claude-agent-sdk',
    toolTaxonomy: CLAUDE_TOOL_TAXONOMY,
    authFixHint: 'stub',
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: false,
      systemPromptTransport: 'systemPrompt.append',
      subagents: 'configurable'
    },
    createSession(): DriverSession {
      return {
        // Never yields and never ends: this suite only inspects the send path.
        events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
        send: (text: string) => void sent.push(text),
        interrupt: async () => {},
        end: () => {}
      } as DriverSession
    },
    probeAuth: async () => ({ ok: true, detail: 'stub' })
  }
  return { driver, sent }
}

const ev = (type: string, payload: Record<string, unknown>): AgentEvent =>
  ({ type, payload }) as unknown as AgentEvent

let tmp: string, argusHome: string, db: DatabaseSync
let events: AgentEvent[]
let indexed: Array<{ role: string; content: string }>
let mirrored: AgentEvent[]
let sessionId: number
let caseId: number

const mirror = (): SessionMirrorLike => ({
  append: (e) => void mirrored.push(e),
  indexText: (role, content) => void indexed.push({ role, content })
})

/** Two turns of prior conversation, on disk where an imported case would leave them. */
function writeMirrorFile(): void {
  const dir = path.join(caseDir(argusHome, 'NAV-1'), 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    ev('turn.started', { userText: 'earlier question' }),
    ev('assistant.message', { text: 'earlier answer' }),
    ev('turn.started', { userText: 'second earlier question' }),
    ev('assistant.message', { text: 'second earlier answer' })
  ].map((e) => JSON.stringify(e))
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`)
}

function makeSession(over: { resumeCursor: string | null }): {
  session: CaseSession
  sent: string[]
} {
  const { driver, sent } = recordingDriver()
  const session = new CaseSession({
    db,
    argusHome,
    detection: createDetection(),
    caseId,
    caseSlug: 'NAV-1',
    sessionId,
    workspaceRoots: [],
    skillsRoots: [],
    emit: (e) => events.push(e),
    driver,
    mirror: mirror(),
    githubWatermark: () => ({ enabled: false, text: '' }),
    ...over
  })
  return { session, sent }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-hist-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  caseId = createCase(db, argusHome, { slug: 'NAV-1', title: 't' }).id
  sessionId = createSession(db, 'NAV-1', 'claude-agent-sdk').id
  events = []
  indexed = []
  mirrored = []
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('CaseSession first-turn history replay', () => {
  it('prefixes the first send to the driver with a digest of the imported transcript', () => {
    writeMirrorFile()
    const { session, sent } = makeSession({ resumeCursor: null })
    session.send('what now?')
    expect(sent[0]).toContain('earlier question')
    expect(sent[0]).toContain('second earlier answer')
    expect(sent[0]).toContain('prior-conversation-record')
    expect(sent[0].endsWith('what now?')).toBe(true)
  })

  // The whole point of the task: the digest goes to the driver and to nothing that is
  // recorded. In the mirror it would render in the transcript AND be re-exported into the
  // next bundle (replaying a replay); in the title every imported chat is named after the
  // preamble; in indexText it pollutes chat search.
  it('keeps the digest out of the transcript, the title and the FTS index', () => {
    writeMirrorFile()
    const { session, sent } = makeSession({ resumeCursor: null })
    session.send('what now?')
    expect(sent[0]).not.toBe('what now?') // guard: the split is only meaningful if it fired

    const started = events.find((e) => e.type === 'turn.started') as
      | { payload: { userText: string } }
      | undefined
    expect(started?.payload.userText).toBe('what now?')

    const mirroredStart = mirrored.find((e) => e.type === 'turn.started') as
      | { payload: { userText: string } }
      | undefined
    expect(mirroredStart?.payload.userText).toBe('what now?')

    expect(indexed).toEqual([{ role: 'user', content: 'what now?' }])

    const row = db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(sessionId) as {
      title: string
    }
    expect(row.title).toBe('what now?')
  })

  it('does not replay on the second send', () => {
    writeMirrorFile()
    const { session, sent } = makeSession({ resumeCursor: null })
    session.send('first')
    session.send('second')
    expect(sent[1]).toBe('second')
  })

  it('does not replay when the session has a usable cursor', () => {
    writeMirrorFile()
    const { session, sent } = makeSession({ resumeCursor: 'abc-uuid' })
    session.send('hello')
    expect(sent[0]).toBe('hello')
  })

  it('sends unprefixed when the mirror is missing', () => {
    const { session, sent } = makeSession({ resumeCursor: null })
    session.send('hello')
    expect(sent[0]).toBe('hello')
  })

  // A send must never fail because history could not be read. A directory where the mirror
  // file should be makes the read throw (EISDIR) rather than return [].
  it('sends unprefixed when reading the mirror throws', () => {
    fs.mkdirSync(path.join(caseDir(argusHome, 'NAV-1'), 'sessions', `${sessionId}.jsonl`), {
      recursive: true
    })
    const { session, sent } = makeSession({ resumeCursor: null })
    expect(() => session.send('hello')).not.toThrow()
    expect(sent[0]).toBe('hello')
  })
})
