import { describe, expect, it, vi } from 'vitest'
import {
  buildCommands,
  commandForEvent,
  type AssetPaneHandle,
  type CommandContext,
  type PaneCommandState
} from '../commands'

function handle(): AssetPaneHandle {
  return {
    save: vi.fn(),
    improve: vi.fn(),
    draft: vi.fn(),
    discardDraft: vi.fn(),
    cycleViewMode: vi.fn(),
    changeFontSize: vi.fn(),
    toggleWrap: vi.fn(),
    openGotoLine: vi.fn(),
    focus: vi.fn()
  }
}

const PANE: PaneCommandState = {
  mode: 'edit',
  readOnly: false,
  busy: false,
  proposing: false,
  blocked: false,
  hasDraft: false,
  canDraft: false,
  canImprove: true,
  viewMode: 'editor',
  wrap: true
}

function ctx(
  over: Partial<CommandContext> = {},
  pane: Partial<PaneCommandState> | null = {}
): CommandContext {
  return {
    pane: pane === null ? null : { ...PANE, ...pane },
    activePane: () => handle(),
    dirtyPanes: () => [],
    dirtyCount: 0,
    tabCount: 1,
    window: {
      quickOpen: vi.fn(),
      commandPalette: vi.fn(),
      closeTab: vi.fn(),
      nextTab: vi.fn(),
      prevTab: vi.fn()
    },
    ...over
  }
}

const byId = (c: CommandContext, id: string): import('../commands').Command =>
  buildCommands(c).find((x) => x.id === id)!

describe('buildCommands · enabled', () => {
  it('disables everything pane-scoped when no tab is open', () => {
    const c = ctx({ tabCount: 0 }, null)
    for (const id of ['save', 'improve', 'gotoLine', 'toggleWrap', 'closeTab']) {
      expect(byId(c, id).enabled, id).toBe(false)
    }
  })

  it('keeps the two palette commands enabled with no tabs — they are how you get one', () => {
    const c = ctx({ tabCount: 0 }, null)
    expect(byId(c, 'quickOpen').enabled).toBe(true)
    expect(byId(c, 'commandPalette').enabled).toBe(true)
  })

  it('disables Save on a read-only pane', () => {
    expect(byId(ctx({}, { readOnly: true }), 'save').enabled).toBe(false)
  })

  it('disables Save while a run is in flight or a proposal is up', () => {
    expect(byId(ctx({}, { busy: true }), 'save').enabled).toBe(false)
    expect(byId(ctx({}, { proposing: true }), 'save').enabled).toBe(false)
  })

  it('disables Save when validation blocks it', () => {
    expect(byId(ctx({}, { blocked: true }), 'save').enabled).toBe(false)
  })

  it('enables Save all only when something is dirty', () => {
    expect(byId(ctx({ dirtyCount: 0 }), 'saveAll').enabled).toBe(false)
    expect(byId(ctx({ dirtyCount: 2 }), 'saveAll').enabled).toBe(true)
  })

  it('offers Draft only in create mode, and only with something to describe', () => {
    expect(byId(ctx({}, { mode: 'edit', canDraft: true }), 'draft').enabled).toBe(false)
    expect(byId(ctx({}, { mode: 'create', canDraft: false }), 'draft').enabled).toBe(false)
    expect(byId(ctx({}, { mode: 'create', canDraft: true }), 'draft').enabled).toBe(true)
  })

  it('offers Discard draft only when a draft exists on an editable pane', () => {
    expect(byId(ctx({}, { hasDraft: false }), 'discardDraft').enabled).toBe(false)
    expect(byId(ctx({}, { hasDraft: true }), 'discardDraft').enabled).toBe(true)
    expect(byId(ctx({}, { hasDraft: true, readOnly: true }), 'discardDraft').enabled).toBe(false)
  })

  it('leaves the view commands available on a read-only pane — reading is not editing', () => {
    const c = ctx({}, { readOnly: true })
    expect(byId(c, 'cycleViewMode').enabled).toBe(true)
    expect(byId(c, 'toggleWrap').enabled).toBe(true)
    expect(byId(c, 'fontIn').enabled).toBe(true)
  })

  it('enables tab cycling only with more than one tab', () => {
    expect(byId(ctx({ tabCount: 1 }), 'nextTab').enabled).toBe(false)
    expect(byId(ctx({ tabCount: 2 }), 'nextTab').enabled).toBe(true)
  })
})

describe('buildCommands · run', () => {
  it('reaches the active pane at press time, not at build time', () => {
    const h = handle()
    let current: AssetPaneHandle | null = null
    const c = ctx({ activePane: () => current })
    const save = byId(c, 'save')
    current = h // the pane arrives AFTER the descriptor was built
    save.run()
    expect(h.save).toHaveBeenCalledOnce()
  })

  it('does nothing when there is no pane, rather than throwing', () => {
    const c = ctx({ activePane: () => null }, null)
    expect(() => byId(c, 'save').run()).not.toThrow()
  })

  it('Save all saves every dirty pane', () => {
    const a = handle()
    const b = handle()
    byId(ctx({ dirtyCount: 2, dirtyPanes: () => [a, b] }), 'saveAll').run()
    expect(a.save).toHaveBeenCalledOnce()
    expect(b.save).toHaveBeenCalledOnce()
  })

  it('routes the font commands with the right delta', () => {
    const h = handle()
    const c = ctx({ activePane: () => h })
    byId(c, 'fontIn').run()
    byId(c, 'fontOut').run()
    byId(c, 'fontReset').run()
    expect(h.changeFontSize).toHaveBeenNthCalledWith(1, 1)
    expect(h.changeFontSize).toHaveBeenNthCalledWith(2, -1)
    expect(h.changeFontSize).toHaveBeenNthCalledWith(3, 0)
  })

  it('routes the window commands', () => {
    const c = ctx()
    byId(c, 'quickOpen').run()
    byId(c, 'closeTab').run()
    expect(c.window.quickOpen).toHaveBeenCalledOnce()
    expect(c.window.closeTab).toHaveBeenCalledOnce()
  })
})

describe('commandForEvent', () => {
  const cmds = buildCommands(ctx())
  const ev = (over: Partial<import('../commands').KeyLike>): import('../commands').KeyLike => ({
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over
  })

  it('matches a plain modifier chord', () => {
    expect(commandForEvent(cmds, ev({ key: 's', ctrlKey: true }))?.id).toBe('save')
  })

  it('accepts Cmd for Ctrl', () => {
    expect(commandForEvent(cmds, ev({ key: 's', metaKey: true }))?.id).toBe('save')
  })

  it('does not fire Save on Ctrl+Shift+S', () => {
    expect(commandForEvent(cmds, ev({ key: 's', ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('keeps Ctrl+P and Ctrl+Shift+P apart', () => {
    expect(commandForEvent(cmds, ev({ key: 'p', ctrlKey: true }))?.id).toBe('quickOpen')
    expect(commandForEvent(cmds, ev({ key: 'p', ctrlKey: true, shiftKey: true }))?.id).toBe(
      'commandPalette'
    )
  })

  it('matches the font-increase key in both its spellings', () => {
    expect(commandForEvent(cmds, ev({ key: '=', ctrlKey: true }))?.id).toBe('fontIn')
    expect(commandForEvent(cmds, ev({ key: '+', ctrlKey: true, shiftKey: true }))?.id).toBe(
      'fontIn'
    )
  })

  it('is case-insensitive about the reported key', () => {
    expect(commandForEvent(cmds, ev({ key: 'S', ctrlKey: true }))?.id).toBe('save')
  })

  it('returns a matched but DISABLED command, so the caller can still swallow the key', () => {
    const disabled = buildCommands(ctx({ tabCount: 0 }, null))
    const hit = commandForEvent(disabled, ev({ key: 'w', ctrlKey: true }))
    expect(hit?.id).toBe('closeTab')
    expect(hit?.enabled).toBe(false)
  })

  it('returns null for an unbound key', () => {
    expect(commandForEvent(cmds, ev({ key: 'j', ctrlKey: true }))).toBeNull()
  })

  it('ignores commands that carry no keybinding', () => {
    expect(cmds.find((c) => c.id === 'improve')!.keybinding).toBeUndefined()
  })
})
