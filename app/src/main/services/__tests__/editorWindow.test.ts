import { describe, it, expect, beforeEach } from 'vitest'
import {
  EDITOR_IPC,
  type EditorOpenRequest,
  type PersistedTabs,
  type WindowBounds
} from '../../../shared/editorIpc'
import {
  EditorWindowService,
  type EditorWindowHandle,
  type EditorWindowFactory
} from '../editorWindow'

/** A fake window recording every lifecycle call. Mirrors the FakeView pattern in
 *  services/panels/__tests__/panelHost.test.ts. */
export class FakeEditorWindow implements EditorWindowHandle {
  focused = 0
  destroyed = false
  sent: Array<{ channel: string; payload: unknown }> = []
  bounds: WindowBounds = { x: 10, y: 20, width: 1100, height: 780 }
  private closeAttempt: (() => boolean) | null = null
  private closed: (() => void) | null = null
  private moved: (() => void) | null = null

  focus(): void {
    this.focused++
  }
  destroy(): void {
    this.destroyed = true
    this.closed?.()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }
  getBounds(): WindowBounds {
    return this.bounds
  }
  onCloseAttempt(cb: () => boolean): void {
    this.closeAttempt = cb
  }
  onClosed(cb: () => void): void {
    this.closed = cb
  }
  onBoundsChanged(cb: () => void): void {
    this.moved = cb
  }

  // --- test drivers ---
  /** Simulate the user clicking the window's X. Returns whether the close was allowed. */
  userCloses(): boolean {
    const allowed = this.closeAttempt?.() ?? true
    if (allowed) this.destroy()
    return allowed
  }
  userMoves(next: WindowBounds): void {
    this.bounds = next
    this.moved?.()
  }
  /** Mark this window destroyed without firing the `closed` callback — simulates the gap
   *  between Electron destroying a window and the async `closed` event actually being
   *  delivered, so a replacement window can be adopted while this one's callback is still
   *  pending. */
  markDestroyedWithoutEvent(): void {
    this.destroyed = true
  }
  /** Fire the stored `closed` callback directly, without touching `destroyed`. Used to
   *  simulate a stale window's `closed` event arriving after a replacement has already been
   *  adopted. */
  fireStaleClosedEvent(): void {
    this.closed?.()
  }
}

function makeService(overrides?: { loadTabs?: () => PersistedTabs | null }): {
  service: EditorWindowService
  created: FakeEditorWindow[]
  savedBounds: WindowBounds[]
} {
  const created: FakeEditorWindow[] = []
  const savedBounds: WindowBounds[] = []
  const factory: EditorWindowFactory = () => {
    const w = new FakeEditorWindow()
    created.push(w)
    return w
  }
  const service = new EditorWindowService({
    createWindow: factory,
    loadBounds: () => null,
    saveBounds: (bounds) => savedBounds.push(bounds),
    loadTabs: overrides?.loadTabs ?? (() => null)
  })
  return { service, created, savedBounds }
}

const SKILL: EditorOpenRequest = { kind: 'skill', name: 'my-skill', mode: 'edit' }
const REF: EditorOpenRequest = { kind: 'reference', name: 'notes.md', mode: 'edit' }

describe('EditorWindowService.open', () => {
  let harness: ReturnType<typeof makeService>
  beforeEach(() => {
    harness = makeService()
  })

  it('creates a window on first open and sends the open-tab message', () => {
    harness.service.open(SKILL)
    expect(harness.created).toHaveLength(1)
    expect(harness.created[0].sent).toEqual([{ channel: EDITOR_IPC.openTab, payload: SKILL }])
  })

  it('reuses the window and focuses it on a second open', () => {
    harness.service.open(SKILL)
    harness.service.open(REF)
    expect(harness.created).toHaveLength(1)
    expect(harness.created[0].focused).toBe(1)
    expect(harness.created[0].sent.map((s) => s.payload)).toEqual([SKILL, REF])
  })

  it('creates a fresh window after the previous one was closed', () => {
    harness.service.open(SKILL)
    harness.created[0].userCloses()
    expect(harness.service.isOpen()).toBe(false)
    harness.service.open(SKILL)
    expect(harness.created).toHaveLength(2)
  })

  it('ignores a stale window closed event that arrives after a replacement was adopted', () => {
    harness.service.open(SKILL)
    const stale = harness.created[0]
    stale.markDestroyedWithoutEvent()
    harness.service.open(SKILL)
    expect(harness.created).toHaveLength(2)
    const current = harness.created[1]

    stale.fireStaleClosedEvent()

    expect(harness.service.isOpen()).toBe(true)
    expect(harness.service.handle()).toBe(current)
  })

  it('does not save bounds for a stale window bounds-changed event after a replacement', () => {
    harness.service.open(SKILL)
    const stale = harness.created[0]
    stale.markDestroyedWithoutEvent()
    harness.service.open(SKILL)
    expect(harness.created).toHaveLength(2)

    // Simulate `isDestroyed()` briefly still reporting false while the stale window's own
    // teardown is in flight.
    stale.destroyed = false
    harness.savedBounds.length = 0
    stale.userMoves({ x: 1, y: 2, width: 3, height: 4 })

    expect(harness.savedBounds).toEqual([])
  })

  it('saves bounds for the current window on bounds-changed', () => {
    harness.service.open(SKILL)
    const current = harness.created[0]
    const next: WindowBounds = { x: 5, y: 6, width: 700, height: 800 }

    current.userMoves(next)

    expect(harness.savedBounds).toEqual([next])
  })
})

describe('EditorWindowService close handshake', () => {
  let harness: ReturnType<typeof makeService>
  let win: FakeEditorWindow
  beforeEach(() => {
    harness = makeService()
    harness.service.open(SKILL)
    win = harness.created[0]
    win.sent.length = 0
  })

  it('closes immediately when nothing is dirty', () => {
    harness.service.setDirtyCount(0)
    expect(win.userCloses()).toBe(true)
    expect(win.destroyed).toBe(true)
    expect(win.sent).toEqual([])
  })

  it('vetoes the close and asks the renderer when work is dirty', () => {
    harness.service.setDirtyCount(2)
    expect(win.userCloses()).toBe(false)
    expect(win.destroyed).toBe(false)
    expect(win.sent).toEqual([{ channel: EDITOR_IPC.closeRequested, payload: { dirtyCount: 2 } }])
  })

  it('does not re-ask while a prompt is already open', () => {
    harness.service.setDirtyCount(1)
    win.userCloses()
    win.sent.length = 0
    expect(win.userCloses()).toBe(false)
    expect(win.sent).toEqual([])
  })

  it('destroys the window when the renderer allows the close', () => {
    harness.service.setDirtyCount(1)
    win.userCloses()
    harness.service.resolveClose(true)
    expect(win.destroyed).toBe(true)
    expect(harness.service.isOpen()).toBe(false)
  })

  it('keeps the window and re-arms the prompt when the renderer denies', () => {
    harness.service.setDirtyCount(1)
    win.userCloses()
    harness.service.resolveClose(false)
    expect(win.destroyed).toBe(false)

    win.sent.length = 0
    expect(win.userCloses()).toBe(false)
    expect(win.sent).toEqual([{ channel: EDITOR_IPC.closeRequested, payload: { dirtyCount: 1 } }])
  })

  it('ignores a reply that arrives when no prompt is open', () => {
    harness.service.setDirtyCount(1)
    harness.service.resolveClose(true)
    expect(win.destroyed).toBe(false)
  })

  it('forceClose destroys the window without asking, however dirty', () => {
    harness.service.setDirtyCount(3)
    harness.service.forceClose()
    expect(win.destroyed).toBe(true)
    expect(win.sent).toEqual([])
  })

  it('forceClose on a closed service is a no-op', () => {
    harness.service.forceClose()
    expect(() => harness.service.forceClose()).not.toThrow()
  })

  it('resets dirty state for a freshly opened window', () => {
    harness.service.setDirtyCount(2)
    harness.service.forceClose()
    harness.service.open(SKILL)
    const next = harness.created[1]
    expect(next.userCloses()).toBe(true)
  })
})

// makeService here returns { service, created, savedBounds } (created is an array — the file's
// existing convention, see the comment above makeService) rather than the brief's { service, win
// }. `win` below is always `created[0]` after the first open, taken post-open since the window
// does not exist beforehand.
describe('tab-set restore', () => {
  const RESTORED: PersistedTabs = {
    tabs: [{ kind: 'skill', name: 'was-open', mode: 'edit', view: null }],
    activeIndex: 0
  }

  it('sends the persisted tab set when it creates the window', () => {
    const { service, created } = makeService({ loadTabs: () => RESTORED })
    service.open({ kind: 'skill', name: 'clicked', mode: 'edit' })
    const win = created[0]
    expect(win.sent).toContainEqual({ channel: EDITOR_IPC.restoreTabs, payload: RESTORED })
  })

  // Ordering is the whole contract: the renderer dedupes on open, so restore-then-open focuses
  // the clicked asset if it was already among the restored tabs. The other order would leave
  // the user staring at whatever tab restore made active.
  it('sends the restore before the open that triggered it', () => {
    const { service, created } = makeService({ loadTabs: () => RESTORED })
    service.open({ kind: 'skill', name: 'clicked', mode: 'edit' })
    const win = created[0]
    const restore = win.sent.findIndex((s) => s.channel === EDITOR_IPC.restoreTabs)
    const open = win.sent.findIndex((s) => s.channel === EDITOR_IPC.openTab)
    expect(restore).toBeGreaterThanOrEqual(0)
    expect(restore).toBeLessThan(open)
  })

  it('sends nothing to restore when there is no persisted set', () => {
    const { service, created } = makeService({ loadTabs: () => null })
    service.open({ kind: 'skill', name: 'clicked', mode: 'edit' })
    const win = created[0]
    expect(win.sent.some((s) => s.channel === EDITOR_IPC.restoreTabs)).toBe(false)
  })

  // Restore is a window-creation event, not an open event. A second open focuses a window that
  // is already showing its tabs; replaying the set would resurrect tabs the user just closed.
  it('does not restore again when a second asset opens into the live window', () => {
    const { service, created } = makeService({ loadTabs: () => RESTORED })
    service.open({ kind: 'skill', name: 'clicked', mode: 'edit' })
    service.open({ kind: 'skill', name: 'second', mode: 'edit' })
    const win = created[0]
    expect(win.sent.filter((s) => s.channel === EDITOR_IPC.restoreTabs)).toHaveLength(1)
  })

  // The window dies with the app (spec §3.4), but it can also be closed and reopened within one
  // session — and then the set it had is the one to come back to.
  it('restores again after the window is closed and reopened', () => {
    const { service, created } = makeService({ loadTabs: () => RESTORED })
    service.open({ kind: 'skill', name: 'clicked', mode: 'edit' })
    created[0].userCloses()
    service.open({ kind: 'skill', name: 'again', mode: 'edit' })
    // Asserted on the SECOND window specifically. Flat-mapping `sent` across every created
    // window and asserting `>= 1` was vacuous: the first window alone always contributes one
    // restore, so the assertion held even with a latch making restore fire only ever once.
    expect(created).toHaveLength(2)
    expect(created[1].sent.some((s) => s.channel === EDITOR_IPC.restoreTabs)).toBe(true)
  })
})
