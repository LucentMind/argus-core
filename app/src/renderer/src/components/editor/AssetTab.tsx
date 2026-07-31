import { useEffect, useState } from 'react'
import { AssetPane } from './AssetPane'
import { readAsset } from './assetIo'
import { skillTemplate, referenceTemplate } from '../library/assetTemplates'
import { bannerOnOpen, type DraftBanner } from '../../lib/draftState'
import type { DraftRecord, EditorOpenRequest } from '../../../../shared/editorIpc'

export interface AssetTabProps {
  req: EditorOpenRequest
  onDirtyChange: (dirty: boolean) => void
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
export function AssetTab({ req, onDirtyChange }: AssetTabProps): React.JSX.Element {
  const { kind, name, mode } = req
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const disk = await readAsset(kind, name)
      const draft = await window.argus.editor.readDraft({ kind, name })
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
      const all = mode === 'create' ? await window.argus.editor.listDrafts() : []
      if (!live) return
      setResolved({
        doc: draft ? draft.content : baseline,
        baseline,
        hash: draft ? draft.baseHash : (disk?.hash ?? null),
        banner: bannerOnOpen(draft, disk),
        draftAt: draft?.updatedAt ?? null,
        otherDrafts: all
          .filter((d) => d.kind === kind && d.mode === 'create' && d.name !== name)
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          // Cap: the banner is a strip of buttons, not a list view. Increment 5's quick-open
          // Drafts section is where the rest live.
          .slice(0, 5)
      })
    })()
    return () => {
      live = false
    }
  }, [kind, name, mode])

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
      initialDoc={resolved.doc}
      initialBaseline={resolved.baseline}
      initialHash={resolved.hash}
      initialBanner={resolved.banner}
      initialDraftAt={resolved.draftAt}
      otherDrafts={resolved.otherDrafts}
      onDirtyChange={onDirtyChange}
    />
  )
}
