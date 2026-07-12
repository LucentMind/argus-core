import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { PanelThemeName } from '../../../../shared/panelTheme'
import {
  PanelHost,
  type OpenPanelInput,
  type PanelView,
  type PanelViewFactory,
  type PanelKey
} from '../panelHost'

// A fake WebContentsView recording lifecycle calls; identity = webContentsId.
class FakeView implements PanelView {
  loaded: string[] = []
  themes: PanelThemeName[] = []
  floated = false
  docked = 0
  destroyed = false
  focused = 0
  constructor(readonly webContentsId: number) {}
  loadPanel(url: string): void {
    this.loaded.push(url)
  }
  pushTheme(theme: PanelThemeName): void {
    this.themes.push(theme)
  }
  floatOut(): void {
    this.floated = true
  }
  dockBack(): void {
    this.docked++
    this.floated = false
  }
  destroy(): void {
    this.destroyed = true
  }
  focus(): void {
    this.focused++
  }
}

class FakeFactory implements PanelViewFactory {
  created: FakeView[] = []
  private nextId = 100
  create(): PanelView {
    const v = new FakeView(this.nextId++)
    this.created.push(v)
    return v
  }
}

const fakeDb = {} as DatabaseSync
let factory: FakeFactory
let host: PanelHost

const input = (over: Partial<OpenPanelInput> = {}): OpenPanelInput => ({
  caseSlug: 'CASE-A',
  packId: 'sample-pack',
  windowId: 'text-viewer',
  title: 'Text Viewer',
  entry: 'text-viewer/index.html',
  uiDir: '/packs/sample-pack/ui',
  network: [],
  permissions: ['getCaseContext', 'requestEvidence', 'readEvidence'],
  ...over
})
const key = (over: Partial<OpenPanelInput> = {}): PanelKey => ({
  caseSlug: 'CASE-A',
  packId: 'sample-pack',
  windowId: 'text-viewer',
  ...over
})

beforeEach(() => {
  factory = new FakeFactory()
  host = new PanelHost({ db: fakeDb, argusHome: '/home', factory })
})

describe('PanelHost lifecycle', () => {
  it('open creates a view, loads the entry url, and pushes the theme', () => {
    const info = host.open(input())
    expect(info).toMatchObject({ packId: 'sample-pack', windowId: 'text-viewer', floated: false })
    expect(factory.created).toHaveLength(1)
    expect(factory.created[0].loaded).toEqual(['argus-panel://sample-pack/text-viewer/index.html'])
    expect(factory.created[0].themes).toEqual(['dark'])
  })

  it('re-opening the same key is idempotent: focuses, does NOT create a second view', () => {
    host.open(input())
    host.open(input({ focus: { evidenceId: 9 } }))
    expect(factory.created).toHaveLength(1)
    expect(factory.created[0].focused).toBe(1)
  })

  it('list is case-scoped', () => {
    host.open(input({ caseSlug: 'CASE-A' }))
    host.open(input({ caseSlug: 'CASE-B' }))
    expect(host.list('CASE-A')).toHaveLength(1)
    expect(host.list()).toHaveLength(2)
  })

  it("closeCase destroys only that case's views", () => {
    host.open(input({ caseSlug: 'CASE-A' }))
    host.open(input({ caseSlug: 'CASE-B' }))
    const [a, b] = factory.created
    host.closeCase('CASE-A')
    expect(a.destroyed).toBe(true)
    expect(b.destroyed).toBe(false)
    expect(host.list()).toHaveLength(1)
  })

  it('pop-out then dock-back reparents the SAME view (identity preserved, never destroyed)', () => {
    host.open(input())
    const view = factory.created[0]
    host.popOut(key())
    expect(view.floated).toBe(true)
    expect(host.list('CASE-A')[0].floated).toBe(true)
    host.dockBack(key())
    expect(view.docked).toBe(1)
    expect(view.destroyed).toBe(false) // reparent, not recreate
    expect(factory.created).toHaveLength(1) // no new view
    expect(host.list('CASE-A')[0].floated).toBe(false)
  })

  it('setTheme pushes to every open panel and to newly-opened ones', () => {
    host.open(input())
    host.setTheme('light')
    expect(factory.created[0].themes).toEqual(['dark', 'light'])
    host.open(input({ caseSlug: 'CASE-B' }))
    expect(factory.created[1].themes).toEqual(['light'])
  })

  it('bridgeForWebContents routes by webContents id (null for unknown ids)', () => {
    host.open(input())
    expect(host.bridgeForWebContents(factory.created[0].webContentsId)).not.toBeNull()
    expect(host.bridgeForWebContents(999)).toBeNull()
  })
})
