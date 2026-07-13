import { it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { argusToolHandlers } from '../nativeTools'

it('open_panel forwards to the injected openPanel and returns its result', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-op-'))
  const db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'CASE-A', title: 'A' })
  const calls: unknown[] = []
  const h = argusToolHandlers({
    db,
    argusHome: home,
    detection: createDetection(),
    caseId: 1,
    caseSlug: 'CASE-A',
    sessionId: 1,
    emitFinding: () => {},
    openPanel: (packId, windowId, evidenceId) => {
      calls.push([packId, windowId, evidenceId])
      return { ok: true, panel: { packId, windowId } }
    }
  })
  const out = await h.open_panel({
    pack_id: 'sample-bridge-playground',
    window_id: 'playground',
    evidence_id: 7
  })
  expect(calls).toEqual([['sample-bridge-playground', 'playground', 7]])
  expect(JSON.parse(out)).toMatchObject({ ok: true, panel: { windowId: 'playground' } })
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})
