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
import type { PanelWriteSink } from '../bridge'

// A fake WebContentsView recording lifecycle calls; identity = webContentsId.
class FakeView implements PanelView {
  loaded: string[] = []
  themes: PanelThemeName[] = []
  floated = false
  docked = 0
  destroyed = false
  focused = 0
  bounds: Array<{ x: number; y: number; width: number; height: number }> = []
  visibles: boolean[] = []
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
  setBounds(rect: { x: number; y: number; width: number; height: number }): void {
    this.bounds.push(rect)
  }
  setVisible(visible: boolean): void {
    this.visibles.push(visible)
  }
}

class FakeFactory implements PanelViewFactory {
  created: FakeView[] = []
  hooks: Array<{ onFloatClosed(): void }> = []
  private nextId = 100
  create(_input: OpenPanelInput, hooks: { onFloatClosed(): void }): PanelView {
    const v = new FakeView(this.nextId++)
    this.created.push(v)
    this.hooks.push(hooks)
    return v
  }
}

const fakeDb = {} as DatabaseSync
let factory: FakeFactory
let host: PanelHost
let changes: number

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
  changes = 0
  host = new PanelHost({ db: fakeDb, argusHome: '/home', factory, onChange: () => { changes++ } })
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

  it('re-opening with a NEW focus reloads the panel; same/no focus does not', () => {
    host.open(input()) // no focus
    expect(factory.created[0].loaded).toHaveLength(1)
    host.open(input({ focus: { evidenceId: 9 } })) // new focus → reload
    expect(factory.created).toHaveLength(1) // same view, not a new one
    expect(factory.created[0].loaded).toHaveLength(2)
    host.open(input({ focus: { evidenceId: 9 } })) // unchanged focus → no reload
    expect(factory.created[0].loaded).toHaveLength(2)
    host.open(input()) // focus cleared → no reload
    expect(factory.created[0].loaded).toHaveLength(2)
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

  it('setBounds/setVisible forward to the keyed view', () => {
    host.open(input())
    host.setBounds(key(), { x: 10, y: 20, width: 300, height: 400 })
    host.setVisible(key(), true)
    expect(factory.created[0].bounds).toEqual([{ x: 10, y: 20, width: 300, height: 400 }])
    expect(factory.created[0].visibles).toEqual([true])
  })

  it('setBounds/setVisible are no-ops for an unknown key', () => {
    expect(() => host.setBounds(key(), { x: 0, y: 0, width: 1, height: 1 })).not.toThrow()
    expect(() => host.setVisible(key(), false)).not.toThrow()
  })

  it('an out-of-band float close docks the panel back and fires onChange', () => {
    host.open(input())
    host.popOut(key())
    expect(host.list('CASE-A')[0].floated).toBe(true)
    const before = changes
    factory.hooks[0].onFloatClosed() // simulate the user closing the float window
    expect(host.list('CASE-A')[0].floated).toBe(false)
    expect(changes).toBe(before + 1)
  })
})

function fakeFactory(): { factory: PanelViewFactory; views: PanelView[] } {
  const views: PanelView[] = []
  let nextId = 100
  const factory: PanelViewFactory = {
    create() {
      const id = nextId++
      const view: PanelView = {
        webContentsId: id,
        loadPanel() {}, pushTheme() {}, floatOut() {}, dockBack() {},
        destroy() {}, focus() {}, setBounds() {}, setVisible() {}
      }
      views.push(view)
      return view
    }
  }
  return { factory, views }
}

it('builds a bridge with write verbs when a sink + write permission are present', () => {
  const { factory, views } = fakeFactory()
  const sink = {
    sendToAgent: async () => 1,
    emitFinding: async () => ({ ok: true }),
    cite: () => {}
  } as unknown as PanelWriteSink
  const host = new PanelHost({ db: {} as never, argusHome: '/x', factory, writeSink: sink })
  host.open({
    caseSlug: 'CASE-A', packId: 'p', windowId: 'w', title: 'W',
    entry: 'w/index.html', uiDir: '/ui', network: [],
    permissions: ['sendToAgent', 'cite'], sessionId: 3
  })
  const bridge = host.bridgeForWebContents(views[0].webContentsId)!
  expect(typeof bridge.sendToAgent).toBe('function')
  expect(typeof bridge.cite).toBe('function')
  expect(bridge.emitFinding).toBeUndefined()
})
