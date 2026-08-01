import { useEffect, useState } from 'react'
import { AssetPane } from './AssetPane'
import { readAsset } from './assetIo'
import { skillTemplate, referenceTemplate } from '../library/assetTemplates'
import { bannerOnOpen, type DraftBanner } from '../../lib/draftState'
import type { AssetPaneHandle, Command, PaneCommandState } from '../../lib/commands'
import type { DraftRecord, EditorOpenRequest, TabViewState } from '../../../../shared/editorIpc'

export interface AssetTabProps {
  req: EditorOpenRequest
  onDirtyChange: (dirty: boolean) => void
  /** This tab is the one on screen. */
  active: boolean
  readOnly: boolean
  /** Shown in the status bar's badge slot (spec §5.5). */
  tier?: string
  onNameChange: (name: string) => void
  /**
   * A save landed, under this name. Optional so the loader's own tests can mount it without a
   * host; the window always supplies it (`TabPane`), and `EditorApp.test.tsx` pins the wiring.
   */
  onSaved?: (name: string) => void
  onViewStateChange: (view: TabViewState) => void
  /** Where this tab was looking when the app last exited. Applied on first activation. */
  initialViewState?: TabViewState | null
  /** Forwarded straight to `AssetPane` untouched — this component resolves disk and drafts, not
   *  the command contract. Stays null/silent while this component is in its `error` or
   *  `Loading…` branch below; every consumer of the handle already null-checks (see `on()` in
   *  lib/commands.ts). */
  paneRef?: React.Ref<AssetPaneHandle>
  onCommandState?: (state: PaneCommandState) => void
  /** Forwarded straight to `AssetPane` untouched — see its doc comment on this same prop. `TabPane`
   *  in EditorApp.tsx passes this only when this tab is active. */
  commands?: readonly Command[]
}

interface Resolved {
  doc: string
  baseline: string
  hash: string | null
  banner: DraftBanner
  draftAt: string | null
  /** Other create-mode drafts, for the resumable-drafts banner. Always `[]` in edit mode. */
  otherDrafts: DraftRecord[]
}

/**
 * Everything that has to be decided *before* there is an editor: what is on disk, whether a
 * draft is waiting, and which banner that combination calls for.
 *
 * Increment 2 did this work inside the component that also owned the editor, which forced the
 * `generation` / `override` / `init.load` remount protocol — the only way to change a mounted
 * buffer. Resolving first and mounting `AssetPane` with plain values deletes all of it: after
 * this point, content changes are transactions.
 */
export function AssetTab({
  req,
  onDirtyChange,
  active,
  readOnly,
  tier,
  onNameChange,
  onSaved,
  onViewStateChange,
  initialViewState = null,
  paneRef,
  onCommandState,
  commands
}: AssetTabProps): React.JSX.Element {
  const { kind, name, mode } = req
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Create-mode identity: a stable id, minted once when this tab opens rather than derived from
  // the typed name (which the user is actively editing — keying on it would make every keystroke
  // a rename, and two create tabs that happen to land on the same typed name would silently
  // overwrite one another; see `keyOf`'s doc comment in main/services/drafts.ts for the defect
  // this replaces). A `useState` initializer, not a value computed in the effect below, so it
  // stays put for this mount's whole life — the only thing that ever changes it is EditorApp
  // remounting this tab (it keys AssetTab on kind/name/mode/draftId). `req.draftId` carries an
  // existing draft's id forward when resuming it (see `resumeDraft` in AssetPane). Edit mode
  // never uses this — the file itself is the identity — so it stays ''.
  const [draftId] = useState<string>(() =>
    mode === 'create' ? req.draftId || crypto.randomUUID() : ''
  )

  useEffect(() => {
    let live = true
    void (async () => {
      const disk = await readAsset(kind, name)
      let draft: DraftRecord | null = null
      if (readOnly) {
        // A read-only asset has no draft and must not acquire one (see AssetPane's `fileDraft`
        // guard), so skip the read entirely rather than resolving a draft that can never apply.
        // Gating here rather than inside the branches also skips the legacy ADOPTION below, which
        // would otherwise write a new id-keyed record for a buffer the user cannot save.
        draft = null
      } else if (mode === 'create') {
        draft = await window.argus.editor.readDraft({ draftId })
        if (!draft) {
          // Legacy fallback (back-compat only — delete once no old drafts remain): a create-mode
          // draft written before draft ids existed has no `draftId` and is still keyed by
          // kind+name (see keyOf in main/services/drafts.ts). Guard on `mode === 'create'` too:
          // an edit-mode draft can legitimately sit at this same kind+name key (its own,
          // unrelated, identity), and must never be mistaken for an orphaned create draft.
          const legacy = await window.argus.editor.readDraft({ kind, name })
          if (legacy && legacy.mode === 'create' && !legacy.draftId) {
            // Guard against a torn-down effect (React StrictMode's simulated remount in dev, or a
            // fast second `openTab`) re-filing content under a `draftId` no live tab holds. Every
            // other async step in this effect already checks `live` before acting; before this
            // guard existed, dev StrictMode ran adoption twice per mount and got away with it only
            // because both runs wrote the same bytes under the same (id-derived) key — an
            // implementation accident, not something to rely on now that `live` gates it.
            if (!live) return
            draft = legacy
            // Adopt it, atomically, in main: the new id-keyed record is written to disk before
            // the legacy kind+name key is discarded, so a crash mid-adoption leaves both copies
            // rather than neither. See `DraftStore.adopt` — this single call replaces what used
            // to be a fire-and-forget `draftChanged` (debounced) followed by an immediate
            // `discardDraft`, which could delete the only on-disk copy before the debounce fired.
            await window.argus.editor.adoptDraft({
              legacy: { kind: legacy.kind, name: legacy.name },
              change: {
                kind: legacy.kind,
                name: legacy.name,
                mode: legacy.mode,
                content: legacy.content,
                baseHash: legacy.baseHash,
                draftId
              }
            })
            if (!live) return
          }
        }
      } else {
        draft = await window.argus.editor.readDraft({ kind, name })
      }
      if (!live) return
      const template = kind === 'skill' ? skillTemplate : referenceTemplate
      if (!disk && mode !== 'create' && !draft) {
        // `readAsset` swallows every error and returns null, so this also covers a transient IPC
        // failure on a file that really exists. Increment 2 reported this by handing the editor a
        // rejecting `load`; saying it here is both plainer and unambiguous — there is no
        // "Loading…" state that can be mistaken for create mode.
        setError(`Could not read ${kind} "${name}".`)
        return
      }
      // The baseline is what counts as *no unsaved work*: disk when there is a file, the template
      // in create mode. Never the draft — a restored draft is unsaved work by definition, and
      // opening it clean is how the close handshake would let it go without a word.
      const baseline = disk ? disk.content : mode === 'create' ? template(name) : ''
      // Create mode only. An edit-mode orphan (its asset deleted while a draft existed) is
      // Increment 5's quick-open problem — spec §10 cut Library visibility for drafts outright.
      const all = mode === 'create' && !readOnly ? await window.argus.editor.listDrafts() : []
      if (!live) return
      setResolved({
        doc: draft ? draft.content : baseline,
        baseline,
        hash: draft ? draft.baseHash : (disk?.hash ?? null),
        banner: bannerOnOpen(draft, disk),
        draftAt: draft?.updatedAt ?? null,
        // Excluded by `draftId`, not `name`: two create drafts can now legitimately share a
        // typed name, so name is no longer a valid proxy for "this tab's own draft" — its stable
        // id is.
        otherDrafts: all
          .filter((d) => d.kind === kind && d.mode === 'create' && d.draftId !== draftId)
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          // Cap: the banner is a strip of buttons, not a list view. Increment 5's quick-open
          // Drafts section is where the rest live.
          .slice(0, 5)
      })
    })()
    return () => {
      live = false
    }
  }, [kind, name, mode, draftId, readOnly])

  if (error) {
    return (
      <div role="alert" className="flex flex-1 items-center justify-center text-sm text-danger">
        {error}
      </div>
    )
  }
  if (!resolved) {
    return <div className="flex flex-1 items-center justify-center text-sm text-dim">Loading…</div>
  }
  return (
    <AssetPane
      kind={kind}
      initialName={name}
      mode={mode}
      draftId={draftId}
      initialDoc={resolved.doc}
      initialBaseline={resolved.baseline}
      initialHash={resolved.hash}
      initialBanner={resolved.banner}
      initialDraftAt={resolved.draftAt}
      otherDrafts={resolved.otherDrafts}
      onDirtyChange={onDirtyChange}
      active={active}
      readOnly={readOnly}
      tier={tier}
      onNameChange={onNameChange}
      onSaved={onSaved}
      onViewStateChange={onViewStateChange}
      initialViewState={initialViewState}
      paneRef={paneRef}
      onCommandState={onCommandState}
      commands={commands}
    />
  )
}
