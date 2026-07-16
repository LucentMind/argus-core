import { describe, it, expect, beforeEach } from 'vitest'
import { PanelsStore, CHAT_TAB } from '../panelsStore'
import { panelKeyStr, type PanelInfo } from '../../../../shared/panels'

const info = (over: Partial<PanelInfo> = {}): PanelInfo => ({
  caseSlug: 'CASE-A',
  packId: 'sample-pack',
  windowId: 'text-viewer',
  title: 'Text Viewer',
  floated: false,
  ...over
})

let store: PanelsStore
beforeEach(() => {
  store = new PanelsStore()
})

describe('PanelsStore', () => {
  it('starts empty on the Chat tab', () => {
    expect(store.get()).toMatchObject({
      caseSlug: null,
      panels: [],
      activeTab: CHAT_TAB,
      occluded: false
    })
  })

  it('setCase resets panels + active tab when the slug changes', () => {
    store.setPanels([info()])
    store.setActiveTab(panelKeyStr(info()))
    store.setCase('CASE-B')
    expect(store.get().caseSlug).toBe('CASE-B')
    expect(store.get().panels).toEqual([])
    expect(store.get().activeTab).toBe(CHAT_TAB)
  })

  it('setCase to the SAME slug is a no-op (no reset)', () => {
    store.setCase('CASE-A')
    store.setPanels([info()])
    store.setCase('CASE-A')
    expect(store.get().panels).toHaveLength(1)
  })

  it('activeKey returns the PanelKey of the active tab, or null on Chat', () => {
    store.setPanels([info()])
    expect(store.activeKey()).toBeNull()
    store.setActiveTab(panelKeyStr(info()))
    expect(store.activeKey()).toEqual({
      caseSlug: 'CASE-A',
      packId: 'sample-pack',
      windowId: 'text-viewer'
    })
  })

  it('falls back to Chat when the active panel is no longer open', () => {
    store.setPanels([info()])
    store.setActiveTab(panelKeyStr(info()))
    store.setPanels([]) // panel closed elsewhere (panels:changed)
    expect(store.get().activeTab).toBe(CHAT_TAB)
    expect(store.activeKey()).toBeNull()
  })

  it('occludes when a modal OR the launcher menu is open (independent sources)', () => {
    // A docked panel is a native WebContentsView that paints over DOM, so the launcher
    // dropdown is invisible/unclickable unless the view is hidden while the menu is open.
    expect(store.get().occluded).toBe(false)
    store.setLauncherOpen(true)
    expect(store.get().occluded).toBe(true) // launcher alone occludes
    store.setOccluded(true) // a modal comes up too
    expect(store.get().occluded).toBe(true)
    store.setLauncherOpen(false) // launcher closes, modal still up
    expect(store.get().occluded).toBe(true)
    store.setOccluded(false) // modal closes → fully un-occluded
    expect(store.get().occluded).toBe(false)
  })

  it('activate() selects a panel whose case matches the current case', () => {
    // The agent's open_panel opens a panel in the main process; main broadcasts
    // panels:activate so the renderer selects it (as user-initiated opens already do).
    store.setCase('CASE-A')
    store.activate({ caseSlug: 'CASE-A', packId: 'sample-pack', windowId: 'text-viewer' })
    expect(store.get().activeTab).toBe(panelKeyStr(info()))
  })

  it('activate() ignores a panel from a different case (stale/foreign broadcast)', () => {
    store.setCase('CASE-A')
    store.activate({ caseSlug: 'CASE-B', packId: 'sample-pack', windowId: 'text-viewer' })
    expect(store.get().activeTab).toBe(CHAT_TAB)
  })

  it('notifies subscribers on change', () => {
    let n = 0
    const off = store.subscribe(() => {
      n++
    })
    store.setOccluded(true)
    store.setDecls([{ packId: 'p', windowId: 'w', title: 'T', handles: [], kind: 'webPanel' }])
    off()
    store.setOccluded(false)
    expect(n).toBe(2)
  })
})
