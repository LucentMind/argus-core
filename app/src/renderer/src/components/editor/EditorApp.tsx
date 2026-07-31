import { useEffect, useRef, useState } from 'react'
import { AssetTab } from './AssetTab'
import { ConfirmHost } from '../ConfirmHost'
import { confirm } from '../../lib/confirmStore'
import { drainOpenTabs } from './editorBootstrap'
import type { EditorOpenRequest } from '../../../../shared/editorIpc'

/**
 * Root of the editor window. Owns window-level concerns only — which asset is open, telling
 * main whether work is dirty, and answering the close handshake. Everything about the asset
 * itself, including its draft, belongs to AssetTab.
 */
export function EditorApp(): React.JSX.Element {
  const [open, setOpen] = useState<EditorOpenRequest | null>(null)
  const [dirty, setDirty] = useState(false)

  // Read across the async confirm in the close handler so the answer reflects the buffer's
  // state now, not when the subscription was created.
  const dirtyRef = useRef(dirty)
  useEffect(() => {
    dirtyRef.current = dirty
    window.argus.editor.setDirty(dirty ? 1 : 0)
  }, [dirty])

  // Drains the module-scope buffer (see editorBootstrap.ts). NOT a raw onOpenTab subscription:
  // main flushes its queued open-tab message on `did-finish-load`, which can precede React's
  // passive effects — subscribing here alone would re-open the dropped-first-message bug that
  // Increment 1 fixed on the main side.
  //
  // Increment 1 asked before swapping to a different asset, because the remount threw the
  // buffer away. It no longer does: main holds the last change in its pending map and writes
  // it on the debounce whether this window still shows the asset or not (spec §4.2, §6.1). The
  // only thing a swap still discards is an in-flight assist run, which is not worth a prompt.
  useEffect(() => drainOpenTabs(setOpen), [setOpen])

  useEffect(
    () =>
      window.argus.editor.onCloseRequested((info) => {
        void (async () => {
          if (!dirtyRef.current) {
            window.argus.editor.respondClose(true)
            return
          }
          // Spec §3.5: reports rather than warns, and deliberately does not claim a destruction
          // that no longer happens. Not `danger` for the same reason.
          const n = Math.max(1, info.dirtyCount)
          const allow = await confirm({
            title: `${n} ${n === 1 ? 'tab has' : 'tabs have'} unsaved changes.`,
            message: "They'll be kept as drafts.",
            confirmLabel: 'Close'
          })
          window.argus.editor.respondClose(allow)
        })()
      }),
    []
  )

  return (
    <div className="flex h-screen flex-col bg-panel text-ink">
      {open ? (
        <AssetTab
          key={`${open.kind}/${open.name}/${open.mode}`}
          req={open}
          onDirtyChange={setDirty}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-dim">
          Nothing open. Pick a skill or reference in the Library.
        </div>
      )}
      <ConfirmHost />
    </div>
  )
}
