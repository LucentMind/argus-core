import { describe, it, expect, beforeEach } from 'vitest'
import { EDITOR_IPC, type EditorOpenRequest, type WindowBounds } from '../../../shared/editorIpc'
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

function makeService(): {
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
    saveBounds: (bounds) => savedBounds.push(bounds)
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
