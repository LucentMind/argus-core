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
}

function makeService(): {
  service: EditorWindowService
  created: FakeEditorWindow[]
} {
  const created: FakeEditorWindow[] = []
  const factory: EditorWindowFactory = () => {
    const w = new FakeEditorWindow()
    created.push(w)
    return w
  }
  const service = new EditorWindowService({
    createWindow: factory,
    loadBounds: () => null,
    saveBounds: () => {}
  })
  return { service, created }
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
})
