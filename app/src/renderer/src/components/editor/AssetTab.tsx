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

  // The content+name this mount's `init.load` (or `override`) actually handed to AssetEditor.
  // Finding 3: a restored draft opens with `pristine: false`, which flips AssetEditor's
  // `bufferPristine` false and thus `draftable` true — firing `draft.onChange` once on mount
  // with content byte-identical to what was just read. Recording that call would re-persist the
  // draft (same bytes, bumped `updatedAt`) on every reopen. `null` means "no seed to compare
  // against" — the create-with-nothing-to-restore branch, where AssetEditor seeds its own
  // template without going through `init.load` at all.
  const seeded = useRef<{ content: string; name: string } | null>(null)

  // Whether `draft.onChange` has actually mirrored something new since this mount's `init` was
  // adopted. Finding 2: create mode with nothing to restore seeds `buffer.current = ''` while
  // AssetEditor holds the template; `draft.onChange` never fires unless the user types
  // (`draftable` stays false), so `buffer.current` never catches up to what gets saved. Without
  // this, `handleSaved`'s `buffer.current === savedContent` compare wrongly takes the "kept
  // typing during the write" branch and files a draft holding the empty string. Reset alongside
  // `seeded` so it tracks the current mount, not the tab's lifetime.
  const everMirrored = useRef(false)

  // Guards every async path below (discard, save's error-branch re-read, the focus listener's
  // re-read) so a resolution landing after unmount cannot call setState. AssetTab is not yet
  // mounted by EditorApp, but Task 9 wires it — a tab swap can unmount mid-flight then.
  //
  // final-review-fixes-2 (found via gate step 5, dev-only): the setup function must set
  // `liveRef.current = true`, not just rely on `useRef(true)`'s initial value. Under dev-mode
  // React.StrictMode (editor.tsx wraps the tree in it), React double-invokes every mount effect
  // once: setup, simulated cleanup, setup again — reusing the same ref, not a fresh one. The
  // simulated cleanup flips `liveRef.current` to false; without re-arming it here, the *second*
  // setup call leaves it false for the component's entire real lifetime, and every guarded path
  // above permanently takes its "unmounted" branch — discard silently does nothing to the UI,
  // and Save's conflict re-read always falls through to the raw IPC error instead of ever
  // classifying and showing the banner. Production builds never double-invoke, so this was
  // invisible there and invisible in jsdom (no StrictMode double-effect there either); only
  // driving a real Save-conflict through a real `npx electron-vite dev` boot ever exercised it.
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  useEffect(() => {
    let live = true
    void (async () => {
      const forced = override.current
      override.current = null
      if (forced) {
        baseHash.current = forced.hash
        buffer.current = forced.content
        if (!live) return
        seeded.current = { content: forced.content, name: initialName }
        everMirrored.current = false
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
        seeded.current = { content: draft.content, name: initialName }
        everMirrored.current = false
        setInit({
          load: async () => ({ content: draft.content, hash: draft.baseHash, pristine: false })
        })
      } else if (disk) {
        baseHash.current = disk.hash
        buffer.current = disk.content
        seeded.current = { content: disk.content, name: initialName }
        everMirrored.current = false
        setInit({ load: async () => ({ content: disk.content, hash: disk.hash }) })
      } else if (mode === 'create') {
        // Create mode with nothing to restore: no `load`, so AssetEditor seeds its template.
        // No seed to compare against — nothing here ever goes through `init.load`.
        baseHash.current = null
        buffer.current = ''
        seeded.current = null
        everMirrored.current = false
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
        seeded.current = null
        everMirrored.current = false
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
        // Finding 3: the one redundant call that fires on mount when a restored draft's
        // `pristine: false` flips `bufferPristine` (and so `draftable`) even though nothing was
        // typed — content and name both still match what `init.load` just handed AssetEditor.
        // Skip it: `buffer.current` above is already correct, but persisting it would rewrite
        // the draft file with byte-identical content purely to bump `updatedAt`.
        //
        // final-review-fixes-2 (regression): this must only swallow *that* mount echo, not any
        // later call that happens to land back on the same bytes — a deliberate revert (type,
        // then delete back to the original text) or a rename away and back both produce exactly
        // that shape, and both need to persist for real: the revert must overwrite the stale
        // `D+X` still on disk, and the rename-back must carry its `replaces` routing (computed
        // above) so the draft follows the name instead of being stranded under the old key.
        // `!everMirrored.current` scopes the skip to "nothing has persisted yet this mount" —
        // the mount echo is always the first call, so it is the only call that can ever see
        // `everMirrored.current` still false. Do not clear `everMirrored` here even though this
        // branch returns before the line that normally sets it true: that stays false precisely
        // because this call performed no persist, which is what keeps `handleSaved`'s "untouched
        // template" branch below correct.
        if (
          !everMirrored.current &&
          seeded.current !== null &&
          content === seeded.current.content &&
          name === seeded.current.name
        ) {
          return
        }
        // Finding 2: marks that this mount has actually mirrored something, so `handleSaved`
        // can tell "the buffer never diverged from what got saved" apart from "buffer.current
        // is stale because nothing was ever typed" (create mode with an untouched template).
        everMirrored.current = true
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
      // Finding 2: `!everMirrored.current` covers create mode with an untouched template, where
      // `buffer.current` was seeded '' and nothing ever made it diverge from that — comparing it
      // against `savedContent` (the template) would wrongly look like the user kept typing
      // during the write and file a draft holding the empty string.
      if (!everMirrored.current || buffer.current === savedContent) {
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
      } else {
        // final-review-fixes-2 (regression): Keep mine keeps the draft file (`discardDraft:
        // false`) but resolves to the *new* disk hash — the draft on disk still carries the
        // hash it was queued under before this resolution. Before the Regression-1 fix above,
        // the remount's mount echo happened to re-file this draft (its content matched the
        // seed, but `everMirrored` was still false so nothing skipped it); now that echo is
        // correctly recognized as "nothing new" and skipped, so nobody re-files it unless this
        // does it explicitly. Left un-filed, the draft's stale `baseHash` makes `bannerOnOpen`
        // raise the staleness banner again on the next reopen, re-asking a question the user
        // already answered. `draftAt` is deliberately left alone: it is only ever written from
        // `onDraftSaved`, once the bytes below are actually confirmed on disk.
        window.argus.editor.draftChanged({
          kind,
          name: filedAs.current,
          mode,
          content: next.content,
          baseHash: next.baseHash
        })
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
    [kind, mode]
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

  if (!init) {
    return <div className="flex flex-1 items-center justify-center text-sm text-dim">Loading…</div>
  }

  // Finding 1 (CRITICAL, data loss): Compare used to be an early `return <DiffView/>`, which
  // unmounted AssetEditor. Its load effect has an empty dependency array and runs exactly once
  // per mount — so Back, which only cleared `compareSnapshot`, remounted AssetEditor and re-ran
  // that effect against the *original* `init.load` closure, silently reverting every keystroke
  // typed since the tab opened (no banner, no error), and reported the tab clean in the
  // process. Fix: never unmount AssetEditor to show the diff. Keep it mounted and hide it while
  // Compare is up, rendering DiffView as a sibling instead — Back then has nothing to revert,
  // because there is no remount, and the dirty report stays stable across Compare too.
  //
  // `compare` bundles the disk snapshot with `compareSnapshot` so both narrow together from one
  // check — `banner.disk` is still the source for `before` because `compareSnapshot` is only
  // ever a `buffer.current` snapshot (see its declaration above; reading `buffer.current` live
  // during render is forbidden by this repo's react-hooks/refs lint rule).
  const compare =
    compareSnapshot !== null && (banner.kind === 'stale' || banner.kind === 'conflict')
      ? { disk: banner.disk, snapshot: compareSnapshot }
      : null

  return (
    <>
      {compare && (
        <DiffView
          before={compare.disk.content}
          after={compare.snapshot}
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
      )}
      {/* `contents` when not comparing: this wrapper stays transparent to layout so
          AssetEditor's own top-level flex div is the effective flex item, unchanged from
          before. `hidden` while comparing removes it from layout without unmounting it.
          `inert` + `aria-hidden` (final-review-fixes-2, hardening): the Tailwind `hidden` class
          only sets `display:none` where a stylesheet is actually loaded — true in the real app,
          false under jsdom, which has no CSS engine. Without these two, this subtree's Use disk /
          Keep mine buttons stay in the accessibility tree while Compare is up, duplicating the
          ones DiffView renders and breaking any `getByRole` query that targets them by name.
          `inert` also keeps focus (and, in the real window, keyboard interaction) out of a
          subtree that looks hidden but jsdom would otherwise still let win it. */}
      <div
        className={compare ? 'hidden' : 'contents'}
        inert={!!compare}
        aria-hidden={!!compare || undefined}
      >
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
      </div>
    </>
  )
}
