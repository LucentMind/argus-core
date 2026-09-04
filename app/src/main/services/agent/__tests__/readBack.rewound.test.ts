import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { caseDir } from '../../paths'
import { createDetection } from '../../packs/detection'
import { argusToolHandlers } from '../nativeTools'
import { buildHistoryDigest, filterLiveEvents } from '../historyDigest'
import { readSessionEvents } from '../mirror'
import { liveTurnIds } from '../liveTurns'
import { seedRewoundSession, TAIL_TEXT, LIVE_TEXT } from './rewoundFixture'

let tmp: string, argusHome: string, db: DatabaseSync
let fx: ReturnType<typeof seedRewoundSession>
const SLUG = 'RB-1'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-readback-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  const caseId = createCase(db, argusHome, { slug: SLUG, title: 'rb' }).id
  fx = seedRewoundSession(db, argusHome, SLUG, caseId)
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('rewound turns never reach the model', () => {
  it('history digest omits the tail', () => {
    const all = readSessionEvents(caseDir(argusHome, SLUG), fx.sessionId)
    const { events } = filterLiveEvents(all, liveTurnIds(db, fx.sessionId))
    const digest = buildHistoryDigest(events)
    expect(digest).toContain(LIVE_TEXT)
    expect(digest).not.toContain(TAIL_TEXT)
  })
  it('read_session_transcript omits the tail and marks the gap', async () => {
    const tools = argusToolHandlers({
      db,
      argusHome,
      detection: createDetection(),
      caseId: fx.caseId,
      caseSlug: SLUG,
      sessionId: fx.sessionId,
      emitFinding: vi.fn(),
      githubWatermark: () => ({ enabled: false, text: '' })
    })
    const out = String(await tools.read_session_transcript({}))
    expect(out).toContain(LIVE_TEXT)
    expect(out).not.toContain(TAIL_TEXT)
    expect(out).toMatch(/2 turns rewound by the user/)
  })
})
