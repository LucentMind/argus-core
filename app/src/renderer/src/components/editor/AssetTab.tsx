import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssetEditor } from '../library/AssetEditor'
import { Btn } from '../ui'
import { readAsset, writeAsset } from './assetIo'
import { DiffView } from './DiffView'
import {
  bannerOnOpen,
  onExternalChange,
  isConflict,
  resolveConflict,
  type ConflictAction,
  type DraftBanner
} from '../../lib/draftState'
import type { EditorOpenRequest } from '../../../../shared/editorIpc'

export interface AssetTabProps {
  req: EditorOpenRequest
  onDirtyChange: (dirty: boolean) => void
  onClose: () => void
}

/** What the next AssetEditor mount should open with. Undefined `load` means create mode with
 *  nothing to restore — AssetEditor seeds its own template. */
interface Init {
  load?: () => Promise<{ content: string; hash: string | null; pristine?: boolean }>
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * One asset, with its draft.
 *
 * Sits between EditorApp (window concerns) and AssetEditor (buffer concerns) and owns
 * everything in spec §4: restore, autosave, staleness and conflict. It deliberately does not
 * own the buffer — it mirrors it through the `draft.onChange` callback — because AssetEditor is
 * replaced by CodeMirror in Increment 3 and this component has to survive that.
 *
 * State that AssetEditor holds internally (buffer, baseHash) is changed here by *remounting*
 * with a new `load`, bumped through `generation`. That is why "Use disk" and "Keep mine" throw
 * away transient editor state — both are deliberate acts on the whole file.
 */
export function AssetTab({ req, onDirtyChange, onClose }: AssetTabProps): React.JSX.Element {
  const { kind, name: initialName, mode } = req
  const [init, setInit] = useState<Init | null>(null)
  const [banner, setBanner] = useState<DraftBanner>({ kind: 'none' })
  const [draftAt, setDraftAt] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  // Non-null while the compare view is open, holding a snapshot of the buffer taken at the
  // moment "Compare" was clicked. Not `buffer.current` read live: React's eslint react-hooks/refs
  // rule forbids reading a ref's `.current` during render (it can change without a re-render),
  // and DiffView is rendered directly from this component's function body, not from an effect.
  const [compareSnapshot, setCompareSnapshot] = useState<string | null>(null)

  // Mirrors `banner` so the focus listener and the async save-error path can read the current
  // banner without resubscribing or capturing a stale value across an await.
  const bannerRef = useRef<DraftBanner>(banner)
  useEffect(() => {
    bannerRef.current = banner
  }, [banner])

  /** Set before a `generation` bump to force the next mount's contents. A ref, not state: the
   *  effect the same click schedules has to read it before any re-render. */
  const override = useRef<{ content: string; hash: string | null; pristine: boolean } | null>(null)

  // AssetEditor's state, mirrored out so the draft and conflict paths can read it without
  // owning it. Refs rather than state: every reader here runs inside a callback or across an
  // await, where a state variable would be the value captured at subscribe time.
  const buffer = useRef('')
  const filedAs = useRef(initialName)
  const baseHash = useRef<string | null>(null)
  const dirty = useRef(false)

  // Guards every async path below (discard, save's error-branch re-read, the focus listener's
  // re-read) so a resolution landing after unmount cannot call setState. AssetTab is not yet
  // mounted by EditorApp, but Task 9 wires it — a tab swap can unmount mid-flight then.
  const liveRef = useRef(true)
  useEffect(
    () => () => {
      liveRef.current = false
    },
    []
  )

  useEffect(() => {
    let live = true
    void (async () => {
      const forced = override.current
      override.current = null
      if (forced) {
        baseHash.current = forced.hash
        buffer.current = forced.content
        if (!live) return
        setInit({
          load: async () => ({
            content: forced.content,
            hash: forced.hash,
            pristine: forced.pristine
          })
        })
        return
      }

      const disk = await readAsset(kind, initialName)
      const draft = await window.argus.editor.readDraft({ kind, name: initialName })
      if (!live) return

      setBanner(bannerOnOpen(draft, disk))
      setDraftAt(draft?.updatedAt ?? null)

      if (draft) {
        baseHash.current = draft.baseHash
        buffer.current = draft.content
        setInit({
          load: async () => ({ content: draft.content, hash: draft.baseHash, pristine: false })
        })
      } else if (disk) {
        baseHash.current = disk.hash
        buffer.current = disk.content
        setInit({ load: async () => ({ content: disk.content, hash: disk.hash }) })
      } else if (mode === 'create') {
        // Create mode with nothing to restore: no `load`, so AssetEditor seeds its template.
        baseHash.current = null
        buffer.current = ''
        setInit({})
      } else {
        // Edit mode with neither a draft nor a readable file. `readAsset` swallows every
        // error and returns null (assetIo.ts), so this also covers a transient IPC failure
        // reading a real, existing asset — not just "the file is truly gone". Passing no
        // `load` here would be indistinguishable from create mode to AssetEditor: `loaded`
        // would never flip and it would render "Loading…" forever with no error and no
        // banner (bannerOnOpen returns 'none' when draft is null). Give it a rejecting
        // `load` instead so AssetEditor's existing error path fires and the user is told.
        baseHash.current = null
        buffer.current = ''
        setInit({
          load: () => Promise.reject(new Error(`Could not read ${kind} "${initialName}".`))
        })
      }
    })()
    return () => {
      live = false
    }
  }, [kind, initialName, generation, mode])

  // Identity-stable: AssetEditor's autosave effect lists this object in its deps, so a new
  // object every render would re-fire it on every render.
  const draft = useMemo(
    () => ({
      onChange: (content: string, name: string): void => {
        buffer.current = content
        const renamed = name !== filedAs.current
        const replaces = renamed ? { kind, name: filedAs.current } : undefined
        filedAs.current = name
        window.argus.editor.draftChanged({
          kind,
          name,
          mode,
          content,
          baseHash: baseHash.current,
          ...(replaces ? { replaces } : {})
        })
      }
    }),
    [kind, mode]
  )

  useEffect(
    () =>
      window.argus.editor.onDraftSaved((s) => {
        // The only thing allowed to claim the draft is kept: it fires strictly after the bytes
        // are on disk (persist-before-adopt, spec §4.2).
        if (s.kind === kind && s.name === filedAs.current) setDraftAt(s.updatedAt)
      }),
    [kind]
  )

  const handleDirty = useCallback(
    (d: boolean) => {
      dirty.current = d
      onDirtyChange(d)
    },
    [onDirtyChange]
  )

  const save = useCallback(
    async (args: { name: string; content: string; baseHash: string | null }): Promise<string> => {
      try {
        return await writeAsset(kind, args.name, args.content, args.baseHash)
      } catch (e) {
        // Classified by re-reading disk, not by matching main's message: that text is not an
        // API, and the create-mode name collision is thrown from the same hash comparison.
        const disk = await readAsset(kind, args.name)
        if (!liveRef.current) throw e
        if (isConflict(args.baseHash, disk)) {
          setBanner({ kind: 'conflict', disk: disk! })
          // Rethrown so AssetEditor still reports the save as failed; worded to point at the
          // banner, which is the only place the conflict can actually be resolved.
          throw new Error('This file changed on disk — resolve it above.')
        }
        throw e
      }
    },
    [kind]
  )

  const handleSaved = useCallback(
    (savedName: string, savedContent: string, hash: string) => {
      baseHash.current = hash
      setBanner({ kind: 'none' })
      if (buffer.current === savedContent) {
        setDraftAt(null)
        void window.argus.editor.discardDraft({ kind, name: savedName })
      } else {
        // The user kept typing while the write was in flight (AssetEditor leaves the textarea
        // live during a save). Re-file the draft against the hash that was just written, or a
        // restore would compare against a hash this very save invalidated and cry staleness.
        window.argus.editor.draftChanged({
          kind,
          name: savedName,
          mode,
          content: buffer.current,
          baseHash: hash
        })
      }
    },
    [kind, mode]
  )

  const discardDraft = useCallback(async (): Promise<void> => {
    // Unmount the current AssetEditor immediately, before the awaits below: leaving it
    // mounted and interactive during the round trips lets a keystroke fire draft.onChange,
    // re-persisting a draft that the remount below then throws away with no dirty guard
    // catching it. Dropping to `init === null` first forces the Loading placeholder — no
    // AssetEditor instance at all — so there is no interactive window in which to lose input.
    //
    // This ordering also fixes a remount race, and must keep doing so: AssetEditor's load
    // effect has an empty dependency array and runs once per mount, so bumping `generation`
    // while a stale `init` is still in state would remount the editor with the *previous*
    // `init.load` closure (this effect's setInit for the new value only lands a commit later)
    // and load the very draft being discarded right back in. Nulling `init` first forces that
    // `!init` early return so no stale instance survives to read the old closure.
    setInit(null)
    await window.argus.editor.discardDraft({ kind, name: filedAs.current })
    const disk = await readAsset(kind, filedAs.current)
    if (!liveRef.current) return
    setDraftAt(null)
    setBanner({ kind: 'none' })
    override.current = disk ? { content: disk.content, hash: disk.hash, pristine: true } : null
    setGeneration((g) => g + 1)
  }, [kind])

  const apply = useCallback(
    (action: ConflictAction): void => {
      const b = bannerRef.current
      if (b.kind !== 'stale' && b.kind !== 'conflict') return
      const next = resolveConflict(action, { buffer: buffer.current, disk: b.disk })
      if (next.discardDraft) {
        void window.argus.editor.discardDraft({ kind, name: filedAs.current })
        setDraftAt(null)
      }
      override.current = {
        content: next.content,
        hash: next.baseHash,
        // Use disk lands on exactly what is on disk, so the buffer really is clean. Keep mine
        // does not, and must stay dirty or the close handshake would let it go silently.
        pristine: action === 'use-disk'
      }
      setCompareSnapshot(null)
      setBanner({ kind: 'none' })
      // Must precede the generation bump: AssetEditor's load effect has an empty dependency
      // array and runs once per mount, so bumping generation while a stale `init` is still in
      // state would remount it with the *previous* `init.load` closure and reload the very
      // content this call is trying to replace. Nulling `init` first forces the `!init` early
      // return so no stale instance survives to read the old closure (see discardDraft above).
      setInit(null)
      setGeneration((g) => g + 1)
    },
    [kind]
  )

  /** Spec §4.4: no fs watcher — external changes are noticed here and at save. */
  useEffect(() => {
    const check = (): void => {
      // A banner already up means the user is mid-decision; do not move the ground under them.
      if (bannerRef.current.kind !== 'none') return
      void (async () => {
        const disk = await readAsset(kind, filedAs.current)
        if (!liveRef.current) return
        if (!disk) return
        if (bannerRef.current.kind !== 'none') return
        const next = onExternalChange({
          dirty: dirty.current,
          baseHash: baseHash.current,
          disk
        })
        if (next.reload) {
          override.current = { content: disk.content, hash: disk.hash, pristine: true }
          // Same ordering requirement as apply(): null init before bumping generation.
          setInit(null)
          setGeneration((g) => g + 1)
        } else if (next.banner.kind !== 'none') {
          setBanner(next.banner)
        }
      })()
    }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [kind])

  const bannerNode =
    banner.kind === 'restored' ? (
      <div
        role="status"
        className="mx-3 mt-2 flex items-center justify-between gap-3 rounded-r2 border border-hair bg-black/20 px-3 py-1.5 text-xs text-dim"
      >
        <span>Restored unsaved draft from {shortTime(banner.updatedAt)}.</span>
        <Btn variant="ghost" onClick={() => void discardDraft()}>
          Discard draft
        </Btn>
      </div>
    ) : banner.kind === 'stale' || banner.kind === 'conflict' ? (
      <div
        role="status"
        className="mx-3 mt-2 flex items-center justify-between gap-3 rounded-r2 border border-review/40 bg-review/10 px-3 py-1.5 text-xs text-review"
      >
        <span>
          {banner.kind === 'stale'
            ? 'This file changed on disk since your draft.'
            : 'The saved version is newer than what you started from.'}
        </span>
        <span className="flex shrink-0 gap-2">
          <Btn variant="ghost" onClick={() => setCompareSnapshot(buffer.current)}>
            Compare
          </Btn>
          <Btn variant="ghost" onClick={() => apply('use-disk')}>
            Use disk
          </Btn>
          <Btn variant="outline" onClick={() => apply('keep-mine')}>
            Keep mine
          </Btn>
        </span>
      </div>
    ) : null

  const status = draftAt ? (
    <span className="font-mono text-[11px] text-faint">Draft · {shortTime(draftAt)}</span>
  ) : null

  if (compareSnapshot !== null && (banner.kind === 'stale' || banner.kind === 'conflict')) {
    return (
      <DiffView
        before={banner.disk.content}
        after={compareSnapshot}
        beforeLabel="On disk"
        afterLabel="Yours"
        actions={
          <>
            <Btn variant="ghost" onClick={() => setCompareSnapshot(null)}>
              Back
            </Btn>
            <Btn variant="ghost" onClick={() => apply('use-disk')}>
              Use disk
            </Btn>
            <Btn variant="primary" onClick={() => apply('keep-mine')}>
              Keep mine
            </Btn>
          </>
        }
      />
    )
  }

  if (!init) {
    return <div className="flex flex-1 items-center justify-center text-sm text-dim">Loading…</div>
  }

  return (
    <AssetEditor
      key={`${kind}/${initialName}/${mode}/${generation}`}
      kind={kind}
      name={initialName}
      mode={mode}
      chrome="window"
      banner={bannerNode}
      status={status}
      draft={draft}
      onDirtyChange={handleDirty}
      load={init.load}
      save={save}
      onSaved={handleSaved}
      onClose={onClose}
    />
  )
}
