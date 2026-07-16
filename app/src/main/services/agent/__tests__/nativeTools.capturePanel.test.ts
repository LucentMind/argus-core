import { it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { argusToolHandlers } from '../nativeTools'

function handlers(
  capturePanel: NonNullable<Parameters<typeof argusToolHandlers>[0]['capturePanel']>
): { h: ReturnType<typeof argusToolHandlers>; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cp-'))
  const db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'CASE-A', title: 'A' })
  const h = argusToolHandlers({
    db,
    argusHome: home,
    detection: createDetection(),
    caseId: 1,
    caseSlug: 'CASE-A',
    sessionId: 1,
    emitFinding: () => {},
    capturePanel
  })
  return {
    h,
    cleanup: () => {
      db.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
}

it('capture_panel forwards ids and returns the ok contract with a Read hint', async () => {
  const calls: unknown[] = []
  const { h, cleanup } = handlers(async (packId, windowId) => {
    calls.push([packId, windowId])
    return {
      ok: true,
      evidenceId: 5,
      relPath: 'evidence/panel-nav-map-x.png',
      artifactType: 'screenshot'
    }
  })
  const out = await h.capture_panel({ pack_id: 'sample-pack', window_id: 'nav-map' })
  expect(calls).toEqual([['sample-pack', 'nav-map']])
  expect(JSON.parse(out)).toMatchObject({
    ok: true,
    evidence_id: 5,
    rel_path: 'evidence/panel-nav-map-x.png',
    artifact_type: 'screenshot'
  })
  expect(JSON.parse(out).hint).toMatch(/Read/)
  cleanup()
})

it('capture_panel surfaces panel-not-open as-is', async () => {
  const { h, cleanup } = handlers(async () => ({
    ok: false,
    reason: 'panel-not-open',
    hint: 'call open_panel'
  }))
  const out = await h.capture_panel({ pack_id: 'p', window_id: 'w' })
  expect(JSON.parse(out)).toEqual({ ok: false, reason: 'panel-not-open', hint: 'call open_panel' })
  cleanup()
})
