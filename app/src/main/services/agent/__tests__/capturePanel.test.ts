import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { slugifyPanelTitle, compactStamp, capturePanelToEvidence } from '../capturePanel'

describe('slugifyPanelTitle', () => {
  it('slugifies a normal title', () => {
    expect(slugifyPanelTitle('Nav Visualizer Map', 'win')).toBe('nav-visualizer-map')
  })
  it('collapses symbols and trims dashes', () => {
    expect(slugifyPanelTitle('  Logs (v2)!!  ', 'win')).toBe('logs-v2')
  })
  it('falls back to the windowId slug when the title is empty', () => {
    expect(slugifyPanelTitle('   ', 'Text_Viewer')).toBe('text-viewer')
  })
  it('falls back to "panel" when both are empty', () => {
    expect(slugifyPanelTitle('', '')).toBe('panel')
  })
})

describe('compactStamp', () => {
  it('strips punctuation and milliseconds', () => {
    expect(compactStamp(new Date('2026-07-14T15:30:12.123Z'))).toBe('20260714T153012Z')
  })
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG magic → 'screenshot'

describe('capturePanelToEvidence', () => {
  it('captures, ingests, and returns a citable screenshot path', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cap-'))
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'CASE-A', title: 'A' })
    const panelHost = {
      capturePanel: async () => ({ ok: true as const, png: PNG, title: 'Nav Visualizer Map' })
    }
    const res = await capturePanelToEvidence(
      { panelHost, db, argusHome: home, detection: createDetection(),
        clock: () => new Date('2026-07-14T15:30:12.000Z') },
      'CASE-A', 'sample-pack', 'text-viewer'
    )
    expect(res).toMatchObject({
      ok: true,
      relPath: 'evidence/panel-nav-visualizer-map-20260714T153012Z.png',
      artifactType: 'screenshot'
    })
    if (res.ok) expect(typeof res.evidenceId).toBe('number')
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('passes through panel-not-open without ingesting', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cap2-'))
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'CASE-A', title: 'A' })
    const panelHost = {
      capturePanel: async () => ({ ok: false as const, reason: 'panel-not-open' as const, hint: 'h' })
    }
    const res = await capturePanelToEvidence(
      { panelHost, db, argusHome: home, detection: createDetection() },
      'CASE-A', 'sample-pack', 'text-viewer'
    )
    expect(res).toEqual({ ok: false, reason: 'panel-not-open', hint: 'h' })
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
})
