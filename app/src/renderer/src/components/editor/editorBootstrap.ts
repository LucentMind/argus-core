import type { EditorOpenRequest, PersistedTabs } from '../../../../shared/editorIpc'

/**
 * Module-scope subscription to `editor:open-tab`, established before `createRoot` runs.
 *
 * Main buffers open-tab messages until `did-finish-load` and flushes them there. That is
 * earlier than React's passive effects are guaranteed to run, so a subscription living only
 * in an effect can miss the first message — the window then opens empty. Registering here and
 * replaying into the component closes the gap from the renderer side.
 */
const pending: EditorOpenRequest[] = []
let sink: ((req: EditorOpenRequest) => void) | null = null

function deliver(req: EditorOpenRequest): void {
  if (sink) sink(req)
  else pending.push(req)
}

/**
 * Subscribe as early as the bridge allows. In the real window `window.argus` is installed by
 * the preload before any module here evaluates, so this is the subscription that matters. In a
 * unit test the bridge is stubbed after import, so it is absent here and {@link drainOpenTabs}
 * subscribes instead — the fallback below.
 */
const detachEarly: (() => void) | null = window.argus?.editor
  ? window.argus.editor.onOpenTab(deliver)
  : null

/**
 * Same race as `editor:open-tab` above, and the same fix: `restoreTabs` is queued behind
 * `openTab` in `EditorWindowHandle.send`'s pre-`did-finish-load` buffer (see
 * `electronEditorWindow.ts`) and both flush in one synchronous pass at `did-finish-load` — well
 * before React's passive effects are guaranteed to have run. Without an equally early
 * subscription here, the ordering contract `EditorWindowService.open` upholds (restore sent
 * before the triggering openTab) would be worthless in the real window: the message that
 * arrives first would be the one most likely to be dropped for want of a listener.
 */
const pendingRestore: PersistedTabs[] = []
let restoreSink: ((tabs: PersistedTabs) => void) | null = null

function deliverRestore(tabs: PersistedTabs): void {
  if (restoreSink) restoreSink(tabs)
  else pendingRestore.push(tabs)
}

// Guarded on `onRestoreTabs` specifically, not just `window.argus?.editor` (unlike the check
// above) — `editorBootstrap.test.ts` stubs a bare `{ editor: { onOpenTab } }` to pin the openTab
// path in isolation, and a broader guard here would throw on that stub's missing method.
const detachRestoreEarly: (() => void) | null = window.argus?.editor?.onRestoreTabs
  ? window.argus.editor.onRestoreTabs(deliverRestore)
  : null

// A no-op outside dev HMR (import.meta.hot is undefined in production and in tests): without
// this, an HMR re-evaluation of this module leaves the previous ipcRenderer listener registered
// alongside the new one, and every open-tab message after that arrives twice.
import.meta.hot?.dispose(() => {
  detachEarly?.()
  detachRestoreEarly?.()
})

/** Attach the live consumer and replay anything that arrived before it existed.
 *  Returns a detach function, so it drops straight into a `useEffect`. */
export function drainOpenTabs(cb: (req: EditorOpenRequest) => void): () => void {
  sink = cb
  while (pending.length > 0) cb(pending.shift()!)
  // Only when the module-scope subscription could not be established — never both, or every
  // open-tab message would be delivered twice.
  const detachLate = detachEarly ? null : window.argus.editor.onOpenTab(deliver)
  return () => {
    sink = null
    detachLate?.()
  }
}

/** Same shape as {@link drainOpenTabs}, for `editor:restore-tabs`. */
export function drainRestoreTabs(cb: (tabs: PersistedTabs) => void): () => void {
  restoreSink = cb
  while (pendingRestore.length > 0) cb(pendingRestore.shift()!)
  const detachLate = detachRestoreEarly ? null : window.argus.editor.onRestoreTabs(deliverRestore)
  return () => {
    restoreSink = null
    detachLate?.()
  }
}
