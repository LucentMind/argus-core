import { useCallback, useEffect, useRef, useState } from 'react'
import { corpusRows, draftRows, type AssetRow } from './palette'

/**
 * Field-by-field, not `===`: every refresh mints fresh row objects (`corpusRows`/`draftRows`
 * build new object literals every call), so a reference comparison would never be equal even
 * when nothing changed. `draft` is optional and only ever primitives, so a flat comparison is
 * enough.
 */
function sameRow(a: AssetRow, b: AssetRow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.name === b.name &&
    a.title === b.title &&
    a.description === b.description &&
    a.tier === b.tier &&
    a.draft?.draftId === b.draft?.draftId &&
    a.draft?.kind === b.draft?.kind &&
    a.draft?.mode === b.draft?.mode &&
    a.draft?.updatedAt === b.draft?.updatedAt
  )
}

/**
 * Finding 7: a broadcast-driven refresh (`skills:changed` / `refsync:changed`) commonly returns
 * content identical to what is already held — the broadcast fires on ANY change to either
 * corpus, not only one that touches this window's asset list. Minting a fresh array every time
 * anyway means `EditorApp`'s `linkTargets` memo (which depends on `rows`) gets a new identity for
 * no semantic reason, which in turn defeats every mounted `TabPane`'s `memo` — see the comment on
 * `linkTargets` in EditorApp.tsx.
 */
function sameRows(a: readonly AssetRow[], b: readonly AssetRow[]): boolean {
  return a.length === b.length && a.every((row, i) => sameRow(row, b[i]!))
}

/**
 * Everything quick open can offer (spec §6.2): every skill and reference, plus the drafts that
 * have no asset row of their own (§4.5).
 *
 * Fetched rather than derived from `useAssetTiers`'s broadcasts, because a reference's TITLE is
 * not in any broadcast — `ReferenceStatus` carries file, tier and author and stops there. The
 * corpus channel reads it off frontmatter in main.
 *
 * Refreshed on `skills:changed` / `refsync:changed` so a fork or a claim is reflected without a
 * restart, and on demand — the host calls `refresh()` as it opens the palette, which is what
 * keeps the Drafts section current without subscribing to every debounced draft write.
 */
export function useEditorAssets(): { rows: AssetRow[]; refresh: () => void } {
  const [rows, setRows] = useState<AssetRow[]>([])
  // Guards two things at once: a response landing after unmount, and an older response landing
  // after a newer one (a `skills:changed` burst during a slow read reorders trivially).
  const runId = useRef(0)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const refresh = useCallback((): void => {
    const my = ++runId.current
    void (async () => {
      try {
        const [corpus, drafts] = await Promise.all([
          window.argus.editor.corpus(),
          window.argus.editor.listDrafts()
        ])
        if (!live.current || runId.current !== my) return
        const next = [...corpusRows(corpus), ...draftRows(drafts, corpus)]
        // Skip the identity churn when nothing actually changed — see `sameRows` above.
        setRows((prev) => (sameRows(prev, next) ? prev : next))
      } catch {
        // Swallowed deliberately, matching `useAssetTiers`: a palette that opens empty is far
        // better than a window that will not render because one read failed.
        if (live.current && runId.current === my) setRows((prev) => (prev.length === 0 ? prev : []))
      }
    })()
  }, [])

  useEffect(() => {
    refresh()
    const offSkills = window.argus.skills.onChanged(() => refresh())
    const offRefs = window.argus.refsync.onChanged(() => refresh())
    return () => {
      offSkills()
      offRefs()
    }
  }, [refresh])

  return { rows, refresh }
}
