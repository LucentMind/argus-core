import { useCallback, useEffect, useState } from 'react'
import type { RecentRepo } from '../../../shared/types'
import { Btn, IconBtn, MenuButton, type MenuItem } from './ui'

/** Renderer-side twin of main's `repoKey`. Path comparison only — never used to build a path,
 *  so it does not need `node:path` (which the renderer cannot import anyway). Normalizes
 *  separators and drops a trailing one, matching what `path.resolve` does to an already-
 *  absolute path; case is deliberately not folded, same as main. */
function sameRepo(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  return norm(a) === norm(b)
}

/**
 * Repo picker: previously-linked repos in a dropdown, with Browse… falling through to the
 * native folder dialog. Shared by the case rail's Link-repo button and Settings' Add… button,
 * which differ only in their trigger and their exclusion list.
 *
 * When the fetched history itself is empty the trigger opens the native dialog DIRECTLY and
 * renders no menu at all — a first-run user gets exactly the pre-feature behavior instead of a
 * menu holding one useless item. That check is on the raw fetch, not on the post-exclusion list:
 * a history that exists but is entirely excluded (e.g. every recent repo is already linked to
 * this case) still renders the menu, just with nothing above the Browse… row — the user can see
 * why (everything they'd add is already here) rather than getting bounced straight to a dialog.
 */
export function RepoPickerMenu({
  onPick,
  exclude,
  trigger
}: {
  /** Called with the chosen path — from a recent entry or from the native dialog. */
  onPick: (repoPath: string) => void
  /** Paths to hide, e.g. repos already linked to this case or already in the defaults. */
  exclude: readonly string[]
  /** Icon trigger (dense rail) or text trigger (Settings). */
  trigger: { icon: React.ReactNode; label: string } | { text: string }
}): React.JSX.Element {
  // null = the initial `recent()` call hasn't settled yet. Kept distinct from `[]` (a settled
  // fetch that genuinely returned nothing) so the trigger doesn't render its no-recents fallback
  // for one frame before flipping to the menu — that flash would make an early click land on
  // the wrong branch (direct-dialog instead of the menu the fetch was about to populate).
  const [recent, setRecent] = useState<RecentRepo[] | null>(null)

  useEffect(() => {
    let live = true
    // A rejected recent() must not leave a dead button: settle to an empty list so the trigger
    // falls back to the direct-dialog path below, same as a genuinely-empty history.
    void window.argus.workspaces.recent().then(
      (r) => {
        if (live) setRecent(r)
      },
      () => {
        if (live) setRecent([])
      }
    )
    return () => {
      live = false
    }
  }, [])

  const browse = useCallback(async (): Promise<void> => {
    const p = await window.argus.workspaces.pick()
    if (p) onPick(p)
  }, [onPick])

  if (recent === null) {
    // Still loading: render neither the menu nor the fallback button so a click can't land on
    // stale (pre-fetch) state.
    return <></>
  }

  if (recent.length === 0) {
    return 'text' in trigger ? (
      <Btn onClick={() => void browse()}>{trigger.text}</Btn>
    ) : (
      <IconBtn
        aria-label={trigger.label}
        title={trigger.label}
        size="xs"
        onClick={() => void browse()}
      >
        {trigger.icon}
      </IconBtn>
    )
  }

  const offered = recent.filter((r) => !exclude.some((e) => sameRepo(e, r.path)))
  const items: MenuItem[] = [
    ...offered.map((r) => ({ label: r.name, onSelect: () => onPick(r.path) })),
    { label: 'Browse…', onSelect: () => void browse() }
  ]

  return 'text' in trigger ? (
    <MenuButton label={trigger.text} items={items} align="right" aria-label={trigger.text} />
  ) : (
    <MenuButton
      label={trigger.icon}
      items={items}
      size="iconXs"
      variant="ghost"
      align="left"
      nocaret
      aria-label={trigger.label}
      title={trigger.label}
    />
  )
}
