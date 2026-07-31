// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EditorOpenRequest, PersistedTabs } from '../../../../../shared/editorIpc'

const SKILL: EditorOpenRequest = { kind: 'skill', name: 'a-skill', mode: 'edit' }
const REF: EditorOpenRequest = { kind: 'reference', name: 'b.md', mode: 'edit' }
const RESTORED: PersistedTabs = {
  tabs: [{ kind: 'skill', name: 'was-open', mode: 'edit', view: null }],
  activeIndex: 0
}

/**
 * Pins the early path that the six EditorApp tests never exercise: in jsdom `window.argus` is
 * absent at import time (it's stubbed by the test AFTER import), so those tests only ever run
 * the late-subscription fallback in `drainOpenTabs`. Delete `detachEarly`/`deliver`/`pending`
 * from editorBootstrap.ts and every EditorApp test still passes — this file is what would catch
 * that regression: main flushes buffered `editor:open-tab` messages on `did-finish-load`, which
 * can precede React's passive effects, so the subscription must exist at module scope, before
 * any component mounts.
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

    // The subscription happens as a side effect of importing the module, before drainOpenTabs
    // is ever called — that's the whole point of the early path.
    expect(onOpenTab).toHaveBeenCalledTimes(1)
    expect(captured).not.toBeNull()

    // Two opens arrive before the component (and therefore drainOpenTabs) exists.
    captured!(SKILL)
    captured!(REF)

    const received: EditorOpenRequest[] = []
    mod.drainOpenTabs((req) => received.push(req))

    expect(received).toEqual([SKILL, REF])
    // Only one subscription ever: drainOpenTabs must not have subscribed a second time, or
    // every later open-tab message would be delivered twice.
    expect(onOpenTab).toHaveBeenCalledTimes(1)
  })

  // Mirrors the test above for `editor:restore-tabs`. Main flushes `restoreTabs` and `openTab`
  // in the same synchronous `did-finish-load` pass (electronEditorWindow.ts), restore first —
  // the ordering contract `EditorWindowService.open` upholds is worthless if the message that
  // arrives first is also the one most likely to arrive before any listener exists. Delete
  // `detachRestoreEarly`/`deliverRestore`/`pendingRestore` and this is what would catch it.
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

    // Arrives before the component (and therefore drainRestoreTabs) exists.
    captured!(RESTORED)

    const received: PersistedTabs[] = []
    mod.drainRestoreTabs((tabs) => received.push(tabs))

    expect(received).toEqual([RESTORED])
    expect(onRestoreTabs).toHaveBeenCalledTimes(1)
  })

  // A bridge that has `onOpenTab` but not `onRestoreTabs` (this file's first test's stub) must
  // not crash the module at import time — the restore guard has to check for its own method,
  // not just `window.argus?.editor`'s presence.
  it('does not throw when the bridge stub omits onRestoreTabs', async () => {
    const onOpenTab = vi.fn(() => () => {})
    ;(window as unknown as { argus: unknown }).argus = { editor: { onOpenTab } }

    await expect(import('../editorBootstrap')).resolves.toBeDefined()
  })
})
