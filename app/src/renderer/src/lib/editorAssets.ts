import { useCallback, useEffect, useRef, useState } from 'react'
import { corpusRows, draftRows, type AssetRow } from './palette'

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
        setRows([...corpusRows(corpus), ...draftRows(drafts, corpus)])
      } catch {
        // Swallowed deliberately, matching `useAssetTiers`: a palette that opens empty is far
        // better than a window that will not render because one read failed.
        if (live.current && runId.current === my) setRows([])
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
