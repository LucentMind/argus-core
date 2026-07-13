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
    expect(store.get()).toMatchObject({ caseSlug: null, panels: [], activeTab: CHAT_TAB, occluded: false })
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
    expect(store.activeKey()).toEqual({ caseSlug: 'CASE-A', packId: 'sample-pack', windowId: 'text-viewer' })
  })

  it('falls back to Chat when the active panel is no longer open', () => {
    store.setPanels([info()])
    store.setActiveTab(panelKeyStr(info()))
    store.setPanels([]) // panel closed elsewhere (panels:changed)
    expect(store.get().activeTab).toBe(CHAT_TAB)
    expect(store.activeKey()).toBeNull()
  })

  it('notifies subscribers on change', () => {
    let n = 0
    const off = store.subscribe(() => { n++ })
    store.setOccluded(true)
    store.setDecls([{ packId: 'p', windowId: 'w', title: 'T', handles: [], kind: 'webPanel' }])
    off()
    store.setOccluded(false)
    expect(n).toBe(2)
  })
})
