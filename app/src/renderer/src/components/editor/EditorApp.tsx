import { useCallback, useEffect, useRef, useState } from 'react'
import { AssetEditor } from '../library/AssetEditor'
import { ConfirmHost } from '../ConfirmHost'
import { confirm } from '../../lib/confirmStore'
import { drainOpenTabs } from './editorBootstrap'
import type { EditorOpenRequest } from '../../../../shared/editorIpc'

/**
 * Root of the editor window. Increment 1 keeps AssetEditor's behaviour untouched and only
 * moves it out of the modal: this component owns the window-level concerns — which asset is
 * open, telling main whether work is dirty, and answering the close handshake.
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

  // Mirrors `open`, but assigned synchronously at swap time: the drain loop below decides the
  // next request against what is on screen *now*, which a state variable read across an `await`
  // cannot tell it.
  const openRef = useRef<EditorOpenRequest | null>(null)
  const show = useCallback((req: EditorOpenRequest | null) => {
    openRef.current = req
    setOpen(req)
  }, [])

  // Drains the module-scope buffer (see editorBootstrap.ts). NOT a raw onOpenTab subscription:
  // main flushes its queued open-tab message on `did-finish-load`, which can precede React's
  // passive effects — subscribing here alone would re-open the dropped-first-message bug that
  // Task 4 fixed on the main side.
  //
  // Requests are queued and drained one at a time rather than pushed straight into state: a
  // different kind/name/mode changes AssetEditor's `key`, so swapping remounts it and throws
  // the buffer away. The modal this replaced made that unreachable (it blocked the Library);
  // a window does not, so ask first. `confirm()` is async, and open-tab messages keep arriving
  // while the prompt is up — the queue is what stops those from being dropped or interleaved.
  useEffect(() => {
    const queue: EditorOpenRequest[] = []
    let draining = false
    let detached = false

    const isSame = (a: EditorOpenRequest | null, b: EditorOpenRequest): boolean =>
      a !== null && a.kind === b.kind && a.name === b.name && a.mode === b.mode

    const drain = async (): Promise<void> => {
      if (draining) return
      draining = true
      try {
        while (queue.length > 0 && !detached) {
          const req = queue.shift()!
          // The "focus the existing window" path: main already raised this window, and every
          // second Edit on the open asset lands here. Never prompt for it.
          if (isSame(openRef.current, req)) continue
          if (openRef.current !== null && dirtyRef.current) {
            const allow = await confirm({
              title: 'Discard your unsaved changes?',
              message: `"${openRef.current.name}" has unsaved changes. Opening "${req.name}" discards them.`,
              confirmLabel: 'Discard and open',
              danger: true
            })
            if (detached) return
            // Deny keeps the current asset — and drops only this request, not the queue.
            if (!allow) continue
          }
          // Deliberately not clearing `dirtyRef` here: the remounted editor reports itself clean
          // a tick later anyway, and a stale `true` only costs a redundant prompt for anything
          // still queued behind this one, which is the safe direction to be wrong in.
          show(req)
        }
      } finally {
        draining = false
      }
    }

    const detach = drainOpenTabs((req) => {
      queue.push(req)
      void drain()
    })
    return () => {
      detached = true
      detach()
    }
  }, [show])

  useEffect(
    () =>
      window.argus.editor.onCloseRequested(() => {
        void (async () => {
          if (!dirtyRef.current) {
            window.argus.editor.respondClose(true)
            return
          }
          // Spec §3.5: from Increment 2 the draft store makes this non-destructive, so the
          // copy reports rather than warns. Increment 2 revises the message to name the count.
          // `danger: true` for now: Increment 1 has no draft store, so closing genuinely
          // discards the buffer. Revert to non-danger once the draft store lands.
          const allow = await confirm({
            title: 'Close the editor?',
            message: 'This asset has unsaved changes.',
            confirmLabel: 'Close editor',
            danger: true
          })
          window.argus.editor.respondClose(allow)
        })()
      }),
    []
  )

  return (
    <div className="flex h-screen flex-col bg-panel text-ink">
      {open ? (
        <AssetEditor
          key={`${open.kind}/${open.name}/${open.mode}`}
          kind={open.kind}
          name={open.name}
          mode={open.mode}
          chrome="window"
          onDirtyChange={setDirty}
          load={
            open.mode === 'create'
              ? undefined
              : open.kind === 'skill'
                ? () => window.argus.skills.read(open.name)
                : () => window.argus.refsync.readRef(open.name)
          }
          // Must resolve to the new base hash — AssetEditor adopts whatever this returns as its
          // next baseHash (see the comment on AssetEditor's `save` prop). Returning `undefined`
          // here would still close the editor on this save, but the next save would then send
          // baseHash: undefined and get rejected as a bogus "changed on disk" conflict.
          save={async ({ name, content, baseHash }) => {
            if (open.kind === 'skill') {
              const { hash } = await window.argus.skills.write(name, content, baseHash)
              return hash
            }
            return window.argus.refsync.writeRef(name, content, baseHash)
          }}
          onClose={() => show(null)}
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
