// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EditorOpenRequest, PersistedTabs } from '../../../../../shared/editorIpc'
import type { EditorMessage } from '../editorBootstrap'

const SKILL: EditorOpenRequest = { kind: 'skill', name: 'a-skill', mode: 'edit' }
const REF: EditorOpenRequest = { kind: 'reference', name: 'b.md', mode: 'edit' }
const RESTORED: PersistedTabs = {
  tabs: [{ kind: 'skill', name: 'was-open', mode: 'edit', view: null }],
  activeIndex: 0
}

/**
 * Pins the early path that the EditorApp tests in `EditorApp.test.tsx` never exercise: in jsdom
 * `window.argus` is absent at import time (it's stubbed by the test AFTER import), so those tests
 * only ever run the late-subscription fallback in `drainEditorMessages`. Delete
 * `detachEarlyOpen`/`deliver`/`pending` from editorBootstrap.ts and every EditorApp test still
 * passes — this file is what would catch that regression: main flushes buffered messages on
 * `did-finish-load`, which can precede React's passive effects, so the subscription must exist at
 * module scope, before any component mounts.
 */
describe('editorBootstrap module-scope subscription', () => {
  beforeEach(() => {
    // Each test re-imports the module fresh so its top-level `window.argus?.editor` check runs
    // against the stub installed for that test, not a previous test's module-cache state.
    vi.resetModules()
    delete (window as { argus?: unknown }).argus
  })

  it('subscribes once at import time and replays buffered opens into the sink in order', async () => {
    let captured: ((req: EditorOpenRequest) => void) | null = null
    const onOpenTab = vi.fn((cb: (req: EditorOpenRequest) => void) => {
      captured = cb
      return () => {}
    })
    ;(window as unknown as { argus: unknown }).argus = { editor: { onOpenTab } }

    const mod = await import('../editorBootstrap')

    // The subscription happens as a side effect of importing the module, before
    // drainEditorMessages is ever called — that's the whole point of the early path.
    expect(onOpenTab).toHaveBeenCalledTimes(1)
    expect(captured).not.toBeNull()

    // Two opens arrive before the component (and therefore drainEditorMessages) exists.
    captured!(SKILL)
    captured!(REF)

    const received: EditorMessage[] = []
    mod.drainEditorMessages((m) => received.push(m))

    expect(received).toEqual([
      { kind: 'open', req: SKILL },
      { kind: 'open', req: REF }
    ])
    // Only one subscription ever: drainEditorMessages must not have subscribed a second time, or
    // every later open-tab message would be delivered twice.
    expect(onOpenTab).toHaveBeenCalledTimes(1)
  })

  // Mirrors the test above for `editor:restore-tabs`. Main flushes `restoreTabs` and `openTab`
  // in the same synchronous `did-finish-load` pass (electronEditorWindow.ts), restore first —
  // the ordering contract `EditorWindowService.open` upholds is worthless if the message that
  // arrives first is also the one most likely to arrive before any listener exists.
  it('subscribes to restoreTabs once at import time and replays a buffered restore', async () => {
    let captured: ((tabs: PersistedTabs) => void) | null = null
    const onRestoreTabs = vi.fn((cb: (tabs: PersistedTabs) => void) => {
      captured = cb
      return () => {}
    })
    ;(window as unknown as { argus: unknown }).argus = {
      editor: { onOpenTab: vi.fn(() => () => {}), onRestoreTabs }
    }

    const mod = await import('../editorBootstrap')

    expect(onRestoreTabs).toHaveBeenCalledTimes(1)
    expect(captured).not.toBeNull()

    // Arrives before the component (and therefore drainEditorMessages) exists.
    captured!(RESTORED)

    const received: EditorMessage[] = []
    mod.drainEditorMessages((m) => received.push(m))

    expect(received).toEqual([{ kind: 'restore', tabs: RESTORED }])
    expect(onRestoreTabs).toHaveBeenCalledTimes(1)
  })

  /**
   * The reason there is ONE queue rather than one per channel. Main puts `restoreTabs` and the
   * `openTab` that triggered the window's creation into a single send queue and flushes both in
   * one synchronous pass, restore first. Per-channel buffers cannot express that: whichever
   * consumer registers first drains its whole buffer first, so the order on the wire is replaced
   * by the order of consumer registration. Split this queue back in two and this fails.
   */
  it('replays both channels in arrival order, not grouped by channel', async () => {
    let emitOpen: ((req: EditorOpenRequest) => void) | null = null
    let emitRestore: ((tabs: PersistedTabs) => void) | null = null
    ;(window as unknown as { argus: unknown }).argus = {
      editor: {
        onOpenTab: (cb: (req: EditorOpenRequest) => void) => {
          emitOpen = cb
          return () => {}
        },
        onRestoreTabs: (cb: (tabs: PersistedTabs) => void) => {
          emitRestore = cb
          return () => {}
        }
      }
    }

    const mod = await import('../editorBootstrap')

    // Exactly main's flush order at `did-finish-load`: restore, then the open that caused it.
    emitRestore!(RESTORED)
    emitOpen!(SKILL)

    const received: EditorMessage[] = []
    mod.drainEditorMessages((m) => received.push(m))

    expect(received).toEqual([
      { kind: 'restore', tabs: RESTORED },
      { kind: 'open', req: SKILL }
    ])
  })

  // A bridge that has `onOpenTab` but not `onRestoreTabs` (this file's first test's stub) must
  // not crash the module at import time — each channel's guard has to check for its own method,
  // not just `window.argus?.editor`'s presence.
  it('does not throw when the bridge stub omits onRestoreTabs', async () => {
    const onOpenTab = vi.fn(() => () => {})
    ;(window as unknown as { argus: unknown }).argus = { editor: { onOpenTab } }

    await expect(import('../editorBootstrap')).resolves.toBeDefined()
  })

  // The LATE path has to tolerate the same partial bridge the early path does. Before the single
  // queue, `drainRestoreTabs` dereferenced `window.argus.editor.onRestoreTabs` unguarded, so a
  // bridge that survived import threw a TypeError at first mount instead.
  it('does not throw on the late path when the bridge omits onRestoreTabs', async () => {
    // Bridge absent at import time, so both early subscriptions are skipped and the drain takes
    // the late path for both channels.
    const mod = await import('../editorBootstrap')
    ;(window as unknown as { argus: unknown }).argus = {
      editor: { onOpenTab: vi.fn(() => () => {}) }
    }

    expect(() => mod.drainEditorMessages(() => {})()).not.toThrow()
  })
})
