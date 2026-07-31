import type { EditorOpenRequest, PersistedTabs } from '../../../../shared/editorIpc'

/**
 * One message from main, tagged with the channel it arrived on.
 *
 * The tag exists so both channels can share ONE queue. Ordering ACROSS the two channels is the
 * contract this whole restore feature rests on (see {@link drainEditorMessages}), and two
 * per-channel queues cannot express it — whatever drains them decides the order, which is not
 * the order main sent them in.
 */
export type EditorMessage =
  { kind: 'open'; req: EditorOpenRequest } | { kind: 'restore'; tabs: PersistedTabs }

/**
 * Module-scope subscription to `editor:open-tab` and `editor:restore-tabs`, established before
 * `createRoot` runs.
 *
 * Main buffers both channels until `did-finish-load` and flushes them there, in one synchronous
 * pass, through one queue (`electronEditorWindow.ts`). That is earlier than React's passive
 * effects are guaranteed to run, so a subscription living only in an effect can miss the first
 * message — the window then opens empty. Registering here and replaying into the component
 * closes the gap from the renderer side.
 *
 * **A SINGLE queue, drained once, in arrival order.** `EditorWindowService.open` sends
 * `restoreTabs` before the `openTab` that caused the window's creation, and the renderer's
 * dedupe turns that into "focus the clicked asset inside the restored set" rather than "add a
 * duplicate at index 0". If the buffered messages were replayed per channel, that ordering would
 * be re-decided here — by which consumer registered first, i.e. by the declaration order of two
 * `useEffect`s in EditorApp — and restore would land AFTER the open it was sent before. Keeping
 * one queue makes the ordering structural instead of a property of effect declaration order.
 */
const pending: EditorMessage[] = []
let sink: ((m: EditorMessage) => void) | null = null

function deliver(m: EditorMessage): void {
  if (sink) sink(m)
  else pending.push(m)
}

const deliverOpen = (req: EditorOpenRequest): void => deliver({ kind: 'open', req })
const deliverRestore = (tabs: PersistedTabs): void => deliver({ kind: 'restore', tabs })

/**
 * Subscribe as early as the bridge allows. In the real window `window.argus` is installed by
 * the preload before any module here evaluates, so these are the subscriptions that matter. In a
 * unit test the bridge is often stubbed after import, so it is absent here and
 * {@link drainEditorMessages} subscribes instead — the fallback below.
 *
 * Each channel is guarded on its OWN method rather than on `window.argus?.editor` as a whole:
 * `editorBootstrap.test.ts` stubs a bare `{ editor: { onOpenTab } }` to pin the openTab path in
 * isolation, and a broader guard would throw on that stub's missing `onRestoreTabs`.
 */
const detachEarlyOpen: (() => void) | null = window.argus?.editor?.onOpenTab
  ? window.argus.editor.onOpenTab(deliverOpen)
  : null
const detachEarlyRestore: (() => void) | null = window.argus?.editor?.onRestoreTabs
  ? window.argus.editor.onRestoreTabs(deliverRestore)
  : null

// A no-op outside dev HMR (import.meta.hot is undefined in production and in tests): without
// this, an HMR re-evaluation of this module leaves the previous ipcRenderer listeners registered
// alongside the new ones, and every message after that arrives twice.
import.meta.hot?.dispose(() => {
  detachEarlyOpen?.()
  detachEarlyRestore?.()
})

/**
 * Attach the live consumer and replay everything that arrived before it existed, in ONE pass in
 * arrival order. Returns a detach function, so it drops straight into a `useEffect`.
 *
 * The consumer dispatches on `m.kind`. There is deliberately no per-channel entry point: a
 * second registration point would reintroduce the cross-channel ordering hazard this queue
 * exists to remove.
 */
export function drainEditorMessages(cb: (m: EditorMessage) => void): () => void {
  sink = cb
  while (pending.length > 0) cb(pending.shift()!)
  // Only for a channel whose module-scope subscription could not be established — never both,
  // or every message on that channel would be delivered twice. `onRestoreTabs` is optional-
  // chained for the same reason the early guard above checks it individually.
  const detachLateOpen = detachEarlyOpen ? null : window.argus.editor.onOpenTab?.(deliverOpen)
  const detachLateRestore = detachEarlyRestore
    ? null
    : window.argus.editor.onRestoreTabs?.(deliverRestore)
  return () => {
    sink = null
    detachLateOpen?.()
    detachLateRestore?.()
  }
}
