import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { ingestArtifact } from '../../ingest'
import { createDetection } from '../../packs/detection'
import { loadPacks } from '../../packs/loader'
import { PackRegistry } from '../../packs/registry'
import { seededPacksDir } from '../../packs/paths'
import { resolvePanelAsset, buildPanelCsp, type PanelWindowLoc } from '../protocol'
import { createPanelBridge } from '../bridge'
import {
  PanelHost,
  type OpenPanelInput,
  type PanelView,
  type PanelViewFactory,
  type PanelViewHooks
} from '../panelHost'
import type { PanelPermission } from '../../../../shared/panels'

// panels/__tests__ → up 5 = app/ (seededPacksDir → <repo>/packs); up 6 = <repo> (fixtures).
const packsSrc = seededPacksDir(path.resolve(__dirname, '../../../../..'))
const FIXTURE = path.resolve(__dirname, '../../../../../../tests/fixtures/sample-applog.txt')
const detection = createDetection()

let home: string
let db: DatabaseSync
let registry: PackRegistry
let evidenceId: number

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-3a4-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'CASE-A', title: 'A' })
  const rec = ingestArtifact(db, home, detection, 'CASE-A', FIXTURE)
  evidenceId = rec.id
  const { packs, errors } = loadPacks(packsSrc)
  expect(errors).toEqual([]) // the shipped pack set (incl. sample-text-viewer) loads clean
  registry = new PackRegistry(packs)
})

const viewer = () =>
  registry.windowDecls().find((d) => d.packId === 'sample-text-viewer' && d.decl.id === 'text-viewer')!

describe('sample-text-viewer end-to-end read path', () => {
  it('ingests the fixture as a "text" artifact the viewer handles', () => {
    const w = viewer()
    expect(w.decl.handles).toContain('text')
    // the seeded item is type "text", so the viewer's handles match real evidence
    const hits = createPanelBridge({
      db,
      argusHome: home,
      caseSlug: 'CASE-A',
      permissions: ['requestEvidence']
    }).requestEvidence!('NoRoute')
    expect(hits.some((h) => h.evidenceId === evidenceId && h.artifactType === 'text')).toBe(true)
  })

  it('serves the bundle over argus-panel:// with a bundle-only CSP and traversal rejected', () => {
    const w = viewer()
    const locs: PanelWindowLoc[] = [
      // webPanel-only; Task 6 routes externalApp before this
      { packId: w.packId, windowId: w.decl.id, uiDir: w.uiDir as string, entry: w.decl.entry }
    ]
    for (const asset of ['index.html', 'app.js', 'app.css']) {
      const p = resolvePanelAsset(locs, `argus-panel://sample-text-viewer/text-viewer/${asset}`)
      expect(p).not.toBeNull()
      expect(fs.existsSync(p!)).toBe(true)
    }
    expect(
      resolvePanelAsset(locs, 'argus-panel://sample-text-viewer/text-viewer/../argus-pack.json')
    ).toBeNull()
    const csp = buildPanelCsp(w.decl.network)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("style-src 'self'")
    expect(csp).not.toContain('http')
  })

  it('the case-bound bridge returns the focus + seeded text (getCaseContext → readEvidence)', () => {
    const bridge = createPanelBridge({
      db,
      argusHome: home,
      caseSlug: 'CASE-A',
      permissions: ['getCaseContext', 'requestEvidence', 'readEvidence'],
      focus: { evidenceId, line: 5 }
    })
    const ctx = bridge.getCaseContext!()
    expect(ctx.caseSlug).toBe('CASE-A')
    expect(ctx.focus).toEqual({ evidenceId, line: 5 })
    const doc = bridge.readEvidence!(ctx.focus!.evidenceId, ctx.focus!.line)
    expect(doc.caseSlug).toBe('CASE-A')
    expect(doc.content).toContain('Router error: NoRoute')
    expect(doc.focusLine).toBe(5)
  })

  it('PanelHost.open loads the viewer entry URL and exposes a case-bound bridge', () => {
    class FakeView implements PanelView {
      loaded: string[] = []
      constructor(readonly webContentsId: number) {}
      loadPanel(url: string): void {
        this.loaded.push(url)
      }
      pushTheme(): void {}
      floatOut(): void {}
      dockBack(): void {}
      destroy(): void {}
      focus(): void {}
      setBounds(): void {}
      setVisible(): void {}
      sendCommand(): void {}
    }
    const created: FakeView[] = []
    const factory: PanelViewFactory = {
      create: (_i: OpenPanelInput, _h: PanelViewHooks): PanelView => {
        const v = new FakeView(1)
        created.push(v)
        return v
      }
    }
    const host = new PanelHost({ db, argusHome: home, factory })
    const w = viewer()
    host.open({
      caseSlug: 'CASE-A',
      packId: 'sample-text-viewer',
      windowId: 'text-viewer',
      title: w.decl.title,
      entry: w.decl.entry,
      // webPanel-only; Task 6 routes externalApp before this
      uiDir: w.uiDir as string,
      network: w.decl.network,
      permissions: w.decl.permissions as PanelPermission[],
      focus: { evidenceId, line: 5 }
    })
    expect(created[0].loaded).toEqual(['argus-panel://sample-text-viewer/text-viewer/index.html'])
    const bridge = host.bridgeForWebContents(1)
    expect(bridge?.getCaseContext!().focus).toEqual({ evidenceId, line: 5 })
    expect(bridge?.readEvidence!(evidenceId).content).toContain('Router error: NoRoute')
  })
})
