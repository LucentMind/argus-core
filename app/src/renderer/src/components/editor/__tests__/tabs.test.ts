import { describe, it, expect } from 'vitest'
import {
  emptyTabs,
  openTab,
  closeTab,
  activateTab,
  markTabSaved,
  renameTab,
  replaceTab,
  setTabDirty,
  setTabView,
  dirtyCount,
  cycleTab
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

// Finding 1: nothing used to flip `mode`, so a saved create-mode tab stayed a create-mode tab —
// which duplicated on the next Library *Edit* and replayed create mode over a real file after a
// restart.
describe('markTabSaved', () => {
  const CREATE = { kind: 'skill', name: 'brand-new', mode: 'create' } as const

  it('turns a saved create-mode tab into an edit-mode one, in place', () => {
    const s = openTab(emptyTabs, CREATE)
    const after = markTabSaved(s, s.tabs[0].id, 'brand-new')
    expect(after.tabs[0].mode).toBe('edit')
    // The id must survive, or the surface remounts and the undo history goes with it.
    expect(after.tabs[0].id).toBe(s.tabs[0].id)
  })

  it('adopts the name the save actually used', () => {
    const s = openTab(emptyTabs, CREATE)
    const after = markTabSaved(s, s.tabs[0].id, 'renamed-before-saving')
    expect(after.tabs[0].name).toBe('renamed-before-saving')
  })

  // `req` is what AssetTab resolves disk and the draft against. Moving it would re-run that
  // resolve under a live CodeMirror — see the note on `markTabSaved`.
  it('leaves the frozen request alone, mode included', () => {
    const s = openTab(emptyTabs, CREATE)
    const after = markTabSaved(s, s.tabs[0].id, 'brand-new')
    expect(after.tabs[0].req).toEqual(CREATE)
  })

  // Half (a) of the finding: `sameAsset` includes `mode`, so without the flip an Edit click on
  // the just-created asset mints a SECOND tab over the same file — and one draft key.
  it('makes a later edit-mode open of the same asset focus rather than duplicate', () => {
    const opened = openTab(emptyTabs, CREATE)
    const s = markTabSaved(opened, opened.tabs[0].id, 'brand-new')
    const again = openTab(s, { kind: 'skill', name: 'brand-new', mode: 'edit' })
    expect(again.tabs).toHaveLength(1)
    expect(again.activeId).toBe(s.tabs[0].id)
  })

  it('leaves an edit-mode tab untouched, identity included', () => {
    const s = openTab(emptyTabs, SKILL)
    const after = markTabSaved(s, s.tabs[0].id, 'my-skill')
    // Identity, not just equality: `TabPane` is memoized on it, and a fresh object every save
    // would re-render every mounted pane.
    expect(after.tabs[0]).toBe(s.tabs[0])
  })

  it('ignores an id that is not open', () => {
    const s = openTab(emptyTabs, SKILL)
    expect(markTabSaved(s, 'nope', 'x')).toEqual(s)
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

  // Finding 2: `replaceTab` minted unconditionally, so forking onto a name that is ALREADY open
  // produced two tabs over one file — same shared draft key and stale `baseHash` as a duplicated
  // create-mode tab. Worse, restore folds the persisted duplicate back through `openTab`, so the
  // tab COUNT changed across a restart.
  it('folds into the existing tab when the replacement is already open', () => {
    const s = openTab(openTab(emptyTabs, SKILL), OTHER)
    const after = replaceTab(s, s.tabs[1].id, SKILL)
    expect(after.tabs).toHaveLength(1)
    expect(after.tabs[0].id).toBe(s.tabs[0].id)
  })

  it('activates the tab it folded into', () => {
    const s = openTab(openTab(emptyTabs, SKILL), OTHER)
    const after = replaceTab(s, s.tabs[1].id, SKILL)
    expect(after.activeId).toBe(s.tabs[0].id)
  })

  // A reference CLAIM replaces a tab with its own kind/name/mode. Matching the tab being replaced
  // against itself would close it instead of re-minting it.
  it('still re-mints when the replacement matches only the tab being replaced', () => {
    const s = openTab(openTab(emptyTabs, REF), OTHER)
    const after = replaceTab(s, s.tabs[0].id, REF)
    expect(after.tabs).toHaveLength(2)
    expect(after.tabs[0].name).toBe('notes.md')
    expect(after.tabs[0].id).not.toBe(s.tabs[0].id)
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

describe('cycleTab', () => {
  const three = ['a', 'b', 'c'].reduce(
    (s, n) => openTab(s, { kind: 'skill', name: n, mode: 'edit' }),
    emptyTabs
  )

  // Positional (`s.tabs[n].id`), not the minted `'t1'`/`'t3'` literals: the contract is "wraps
  // from the last tab to the first (and back)", not "the ids happen to be these strings" — `id`
  // is documented as synthetic (see `Tab.id`), so pinning its literal value here would make this
  // test an accident of `mint`'s naming scheme rather than a check of `cycleTab`'s behaviour.
  it('moves right and wraps', () => {
    const last = three.tabs[three.tabs.length - 1]!.id
    const first = three.tabs[0]!.id
    expect(cycleTab({ ...three, activeId: last }, 1).activeId).toBe(first)
  })

  it('moves left and wraps', () => {
    const first = three.tabs[0]!.id
    const last = three.tabs[three.tabs.length - 1]!.id
    expect(cycleTab({ ...three, activeId: first }, -1).activeId).toBe(last)
  })

  it('is a no-op with no tabs', () => {
    expect(cycleTab(emptyTabs, 1)).toBe(emptyTabs)
  })

  it('is a no-op when nothing is active', () => {
    const s = { ...three, activeId: null }
    expect(cycleTab(s, 1)).toBe(s)
  })
})
