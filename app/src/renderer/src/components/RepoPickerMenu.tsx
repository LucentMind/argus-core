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
 * When there is nothing to offer, the trigger opens the native dialog DIRECTLY and renders no
 * menu at all — a menu whose only row is Browse… is exactly the one-useless-item menu this
 * component exists to avoid, and skipping it is one fewer click. This covers two cases the same
 * way, for the same reason: a first-run user with no history at all, and a history that exists
 * but is entirely excluded (e.g. every recent repo is already linked to this case, or already in
 * the defaults). Both leave nothing worth offering above the Browse… row, so both go straight to
 * the dialog. The check is on the post-exclusion list, not the raw fetch.
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
    let p: string | null
    try {
      p = await window.argus.workspaces.pick()
    } catch (err) {
      // Symmetric with the recent() handling above: an IPC failure here must not leave an
      // unhandled rejection with no feedback — log it and leave the button usable.
      console.warn(`[repos] pick() failed: ${(err as Error).message}`)
      return
    }
    if (!p) return
    // Respect `exclude` here too, not just in the recents branch below, so its name is true for
    // both routes to a path: Add… → Browse… on a repo already in `exclude` (e.g. already a
    // default, or already linked to this case) must not report it and append a duplicate.
    if (exclude.some((e) => sameRepo(e, p!))) return
    onPick(p)
  }, [onPick, exclude])

  if (recent === null) {
    // Still loading: render neither the menu nor the fallback button so a click can't land on
    // stale (pre-fetch) state.
    return <></>
  }

  const offered = recent.filter((r) => !exclude.some((e) => sameRepo(e, r.path)))

  if (offered.length === 0) {
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

  const items: MenuItem[] = [
    ...offered.map((r) => ({ label: r.name, title: r.path, onSelect: () => onPick(r.path) })),
    { label: 'Browse…', onSelect: () => void browse() }
  ]

  // `portal` on both surfaces: each trigger sits inside a scroll container (the case rail's
  // `overflow-y-auto` section box, and the Settings page's scrolling body), and an absolutely
  // positioned panel is clipped at that container's edge no matter its z-index.
  return 'text' in trigger ? (
    <MenuButton label={trigger.text} items={items} align="right" portal aria-label={trigger.text} />
  ) : (
    <MenuButton
      label={trigger.icon}
      items={items}
      size="iconXs"
      variant="ghost"
      // The trigger sits at the right edge of a `justify-between` row inside the case rail's
      // `<aside>`, which is `overflow-hidden` (and whose inner scroll container computes
      // `overflow-x: auto` because it sets `overflow-y: auto`) — a clipping ancestor on both
      // axes. `align="right"` opens the panel leftward, into the card's own width, instead of
      // rightward off the edge of a rail that has no room to give it.
      align="right"
      // ...and `portal`, because `align` only fixes the horizontal axis. The inner
      // `overflow-y-auto` box ends just below the Repos card, so the panel was cut off
      // VERTICALLY mid-list (measured live: panel 141..214 against a clipper ending at 201).
      portal
      nocaret
      aria-label={trigger.label}
      title={trigger.label}
    />
  )
}
