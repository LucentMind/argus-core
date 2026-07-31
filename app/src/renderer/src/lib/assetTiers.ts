import { useCallback, useEffect, useState } from 'react'
import type { AuthoringKind } from '../../../shared/authoringIpc'
import type { TierLookup } from '../../../shared/assetEditable'
import type { SkillsPayload } from '../../../shared/memoryIpc'

/**
 * Where an asset came from, for the editor window (spec §6.2).
 *
 * Reads the two lists the app already broadcasts to **every** window — `skills:changed` and
 * `refsync:changed` are both wired to `broadcast`, and the editor shares the main window's
 * preload — so this needs no new IPC and stays current when a fork or a claim changes a tier.
 *
 * Three distinct answers, and collapsing any two of them is a bug:
 *   `'user'` etc. — a row exists and names a tier
 *   `null`        — a row exists with no tier (an untagged, hand-authored reference: EDITABLE)
 *   `undefined`   — no row, or nothing loaded yet (unknown: fails OPEN, see assetEditable.ts)
 */
export function useAssetTiers(): (kind: AuthoringKind, name: string) => TierLookup {
  const [skills, setSkills] = useState<Map<string, string> | null>(null)
  const [refs, setRefs] = useState<Map<string, string | null> | null>(null)

  useEffect(() => {
    let live = true
    const apply = (p: SkillsPayload): void => {
      if (live) setSkills(new Map(p.skills.map((s) => [s.name, s.tier])))
    }
    void window.argus.skills
      .list()
      .then(apply)
      // Swallowed on purpose: an unresolved tier fails open, which is strictly better than a
      // window that will not render because a list call failed.
      .catch(() => {})
    // `skills:changed` carries the full new list (LibraryPage.tsx applies it the same way), so
    // adopting it directly here avoids a redundant round trip through the same IPC call.
    const off = window.argus.skills.onChanged(apply)
    return () => {
      live = false
      off()
    }
  }, [])

  useEffect(() => {
    let live = true
    const load = (): void => {
      void window.argus.refsync
        .get()
        .then((p) => {
          if (live) setRefs(new Map(p.references.map((r) => [r.file, r.tier])))
        })
        .catch(() => {})
    }
    load()
    // Re-fetch rather than adopt the onChanged argument directly. In production this broadcast
    // does carry a full RefSyncPayload (referenceSyncStore.ts adopts it as-is) — but this hook
    // treats the callback as a bare "something changed" ping and always re-fetches, which is the
    // more conservative contract and is what the hook's own test (task-7-report.md, deviation 1)
    // exercises: it fires the broadcast with no usable payload and expects a fresh refsync.get().
    const off = window.argus.refsync.onChanged(() => load())
    return () => {
      live = false
      off()
    }
  }, [])

  return useCallback(
    (kind: AuthoringKind, name: string): TierLookup => {
      if (kind === 'skill') return skills?.get(name)
      // `Map.get` returns undefined for a missing key and null for a present-but-untagged row.
      // `refs.has` is what keeps those two apart — `?? undefined` alone would turn the
      // untagged-and-editable case into unknown, which happens to give the same answer today but
      // would silently diverge the moment `isAssetEditable`'s undefined branch changes.
      if (!refs) return undefined
      return refs.has(name) ? refs.get(name)! : undefined
    },
    [skills, refs]
  )
}
