import { describe, it, expect } from 'vitest'
import {
  emptyTabs,
  openTab,
  closeTab,
  activateTab,
  renameTab,
  replaceTab,
  setTabDirty,
  setTabView,
  dirtyCount
} from '../tabs'

const SKILL = { kind: 'skill', name: 'my-skill', mode: 'edit' } as const
const OTHER = { kind: 'skill', name: 'other-skill', mode: 'edit' } as const
const REF = { kind: 'reference', name: 'notes.md', mode: 'edit' } as const

describe('openTab', () => {
  it('adds a tab and makes it active', () => {
    const s = openTab(emptyTabs, SKILL)
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0]).toMatchObject({ kind: 'skill', name: 'my-skill', dirty: false })
    expect(s.activeId).toBe(s.tabs[0].id)
  })

  it('gives each tab a distinct id', () => {
    const s = openTab(openTab(emptyTabs, SKILL), OTHER)
    expect(s.tabs[0].id).not.toBe(s.tabs[1].id)
  })

  // Spec §6.1: one tab per asset — reopening focuses.
  it('focuses the existing tab instead of adding a second for the same asset', () => {
    const first = openTab(openTab(emptyTabs, SKILL), OTHER)
    const again = openTab(first, SKILL)
    expect(again.tabs).toHaveLength(2)
    expect(again.activeId).toBe(first.tabs[0].id)
  })

  // Same name, different kind, is a different asset — skills and references are separate
  // namespaces and `notes.md` could plausibly exist in both.
  it('treats the same name under a different kind as a separate tab', () => {
    const s = openTab(openTab(emptyTabs, { kind: 'skill', name: 'notes.md', mode: 'edit' }), REF)
    expect(s.tabs).toHaveLength(2)
  })

  // The dedupe key includes mode: creating "x" while editing an existing "x" is two different
  // buffers over two different baselines, and collapsing them would silently drop one.
  it('treats a create-mode open of the same name as a separate tab', () => {
    const s = openTab(openTab(emptyTabs, SKILL), { ...SKILL, mode: 'create' })
    expect(s.tabs).toHaveLength(2)
  })

  it('carries a restored view state onto the new tab', () => {
    const view = { line: 12, col: 3, scrollFraction: 0.4 }
    const s = openTab(emptyTabs, SKILL, view)
    expect(s.tabs[0].view).toEqual(view)
  })
})

describe('closeTab', () => {
  it('removes the tab', () => {
    const opened = openTab(emptyTabs, SKILL)
    expect(closeTab(opened, opened.tabs[0].id).tabs).toHaveLength(0)
  })

  it('leaves no active tab once the last one closes', () => {
    const opened = openTab(emptyTabs, SKILL)
    expect(closeTab(opened, opened.tabs[0].id).activeId).toBeNull()
  })

  // Closing the tab you are looking at should land you on its right-hand neighbour, the way
  // every tabbed editor behaves — not on the first tab, and not on nothing.
  it('activates the right-hand neighbour when the active tab closes', () => {
    const s = openTab(openTab(openTab(emptyTabs, SKILL), OTHER), REF)
    const middle = s.tabs[1]
    const after = closeTab(activateTab(s, middle.id), middle.id)
    expect(after.activeId).toBe(s.tabs[2].id)
  })

  it('falls back to the left-hand neighbour when the last tab closes', () => {
    const s = openTab(openTab(emptyTabs, SKILL), OTHER)
    const after = closeTab(s, s.tabs[1].id)
    expect(after.activeId).toBe(s.tabs[0].id)
  })

  it('leaves the active tab alone when a different tab closes', () => {
    const s = openTab(openTab(emptyTabs, SKILL), OTHER)
    const after = closeTab(s, s.tabs[0].id)
    expect(after.activeId).toBe(s.tabs[1].id)
  })

  it('ignores an id that is not open', () => {
    const s = openTab(emptyTabs, SKILL)
    expect(closeTab(s, 'nope')).toEqual(s)
  })
})

describe('renameTab', () => {
  // Create mode renames as the user types the name field. The tab id must NOT be derived from
  // the name, or the strip would remount the surface on every keystroke.
  it('changes the name and keeps the id', () => {
    const s = openTab(emptyTabs, { kind: 'skill', name: 'untitled', mode: 'create' })
    const after = renameTab(s, s.tabs[0].id, 'my-new-skill')
    expect(after.tabs[0].name).toBe('my-new-skill')
    expect(after.tabs[0].id).toBe(s.tabs[0].id)
  })

  // Dedupe reads the CURRENT name, so a rename has to be visible to it — otherwise reopening
  // the renamed asset would mint a second tab over the same buffer.
  it('makes the new name dedupe against a later open', () => {
    const opened = openTab(emptyTabs, { kind: 'skill', name: 'untitled', mode: 'create' })
    const s = renameTab(opened, opened.tabs[0].id, 'renamed')
    expect(openTab(s, { kind: 'skill', name: 'renamed', mode: 'create' }).tabs).toHaveLength(1)
  })

  // `req` is what AssetTab resolves disk and draft against. If a rename moved it, every
  // keystroke in the create-mode name field would re-read disk and re-resolve the draft.
  it('leaves the frozen request alone', () => {
    const opened = openTab(emptyTabs, { kind: 'skill', name: 'untitled', mode: 'create' })
    const s = renameTab(opened, opened.tabs[0].id, 'renamed')
    expect(s.tabs[0].req).toEqual({ kind: 'skill', name: 'untitled', mode: 'create' })
    expect(s.tabs[0].name).toBe('renamed')
  })
})

describe('replaceTab', () => {
  // "Edit a copy": the fork lands under a new name, and the tab must become a NEW tab (new id)
  // so the surface remounts editable — see deviation 1.
  it('swaps the asset in place with a fresh id', () => {
    const s = openTab(openTab(emptyTabs, SKILL), OTHER)
    const after = replaceTab(s, s.tabs[0].id, {
      kind: 'skill',
      name: 'my-skill-copy',
      mode: 'edit'
    })
    expect(after.tabs).toHaveLength(2)
    expect(after.tabs[0].name).toBe('my-skill-copy')
    expect(after.tabs[0].id).not.toBe(s.tabs[0].id)
    expect(after.tabs[1].id).toBe(s.tabs[1].id)
  })

  it('activates the replacement', () => {
    const s = openTab(openTab(emptyTabs, SKILL), OTHER)
    const after = replaceTab(s, s.tabs[0].id, { kind: 'skill', name: 'copy', mode: 'edit' })
    expect(after.activeId).toBe(after.tabs[0].id)
  })

  it('drops the old tab view state — a different file needs a different cursor', () => {
    const opened = openTab(emptyTabs, SKILL)
    const withView = setTabView(opened, opened.tabs[0].id, { line: 9, col: 1, scrollFraction: 0.5 })
    expect(withView.tabs[0].view).not.toBeNull()
    const after = replaceTab(withView, opened.tabs[0].id, {
      kind: 'skill',
      name: 'copy',
      mode: 'edit'
    })
    expect(after.tabs[0].view).toBeNull()
  })
})

describe('dirty tracking', () => {
  it('counts only the dirty tabs', () => {
    const s = openTab(openTab(openTab(emptyTabs, SKILL), OTHER), REF)
    const after = setTabDirty(setTabDirty(s, s.tabs[0].id, true), s.tabs[2].id, true)
    expect(dirtyCount(after)).toBe(2)
  })

  it('clears again', () => {
    const s = openTab(emptyTabs, SKILL)
    expect(dirtyCount(setTabDirty(setTabDirty(s, s.tabs[0].id, true), s.tabs[0].id, false))).toBe(0)
  })

  // A closed tab must stop counting, or the close handshake would report phantom unsaved work
  // forever after.
  it('stops counting a tab that was closed while dirty', () => {
    const s = openTab(openTab(emptyTabs, SKILL), OTHER)
    const dirty = setTabDirty(s, s.tabs[0].id, true)
    expect(dirtyCount(closeTab(dirty, s.tabs[0].id))).toBe(0)
  })

  it('ignores an id that is not open', () => {
    const s = openTab(emptyTabs, SKILL)
    expect(setTabDirty(s, 'nope', true)).toEqual(s)
  })
})

describe('activateTab', () => {
  it('moves the active id', () => {
    const s = openTab(openTab(emptyTabs, SKILL), OTHER)
    expect(activateTab(s, s.tabs[0].id).activeId).toBe(s.tabs[0].id)
  })

  it('ignores an id that is not open', () => {
    const s = openTab(emptyTabs, SKILL)
    expect(activateTab(s, 'nope')).toEqual(s)
  })
})
