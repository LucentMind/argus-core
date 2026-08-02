import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'
import type { BundleWorkspaceRef } from '../../../shared/bundle'
import { FolderGit2, Unlink } from 'lucide-react'
import { Chip, IconBtn, SectionLabel, Skeleton, SkeletonRows } from './ui'
import { RepoGraphControl } from './RepoGraphControl'
import { reposStore } from '../lib/reposStore'
import { invalidateRepoSnippets } from '../lib/snippetCache'
import { usePendingDisplay } from '../lib/usePendingDisplay'
import { usePendingList } from '../lib/usePendingList'
import { uiStore } from '../lib/uiStore'
import { DEFAULT_MODE, type ModeId } from '../../../shared/modes'

/** Linked repos as evidence: the repo chips (moved here from the header), with
 *  link/unlink and the graph control. Individual files are not listed — code is
 *  cited per line via [repo/path:line] citations. */
export function ReposSection({
  slug,
  mode = DEFAULT_MODE
}: {
  slug: string
  /** Review mode drops repo-management affordances (unlink, code graph): the repo under
   *  review is not the user's to manage from here. Defaults to investigation behavior. */
  mode?: ModeId
}): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [refs, setRefs] = useState<BundleWorkspaceRef[]>([])
  const [loaded, setLoaded] = useState(false)
  const pending = usePendingList()
  const showSkeleton = usePendingDisplay(!loaded)
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const dynamic = ui.dynamicTheme

  const reload = useCallback((): Promise<void> => {
    // keep the citation domain + snippet cache in sync with link state
    invalidateRepoSnippets(slug)
    void reposStore.load(slug)
    return window.argus.workspaces.list(slug).then(
      (w) => {
        setWorkspaces(w)
        setLoaded(true)
      },
      () => {
        // `loaded` on rejection too, so a failed list does not leave the section skeletal
        // forever. Workspaces are deliberately NOT cleared: a rejected fetch has not established
        // that there are no repos, and wiping a list that loaded successfully a moment ago would
        // make a transient IPC failure read as "no repos".
        setLoaded(true)
      }
    )
  }, [slug])

  useEffect(() => {
    void reload()
  }, [reload])
  useEffect(() => {
    void window.argus.workspaces.refs(slug).then(setRefs)
  }, [slug])
  // live refresh: the agent's workspace_checkout materializes a worktree without
  // any renderer action — the main process broadcasts so the chip updates in place
  useEffect(() => {
    if (!window.argus.workspaces.onChanged) return
    return window.argus.workspaces.onChanged((changed) => {
      if (changed === slug) void reload()
    })
  }, [slug, reload])

  async function link(): Promise<void> {
    const p = await window.argus.workspaces.pick()
    if (!p) return
    // The basename is known the moment the dialog closes, so the chip is on screen before the
    // git spawns start — linkWorkspace runs three, then describeWorkspace runs `git status`
    // over the whole repo, then reload() re-describes every linked repo.
    const id = pending.add(p.split(/[\\/]/).pop() ?? p)
    try {
      await window.argus.workspaces.link(slug, p)
      await reload()
      pending.resolve([id])
    } catch (err) {
      pending.fail([id], (err as Error).message)
    }
  }

  async function unlink(w: WorkspaceInfo): Promise<void> {
    try {
      await window.argus.workspaces.unlink(slug, w.path)
      await reload()
    } catch (err) {
      // `git worktree remove` failing on a locked file is routine on Windows and used to be
      // completely silent. No pending chip on the way in — an unlink either happens or reports
      // why; there is nothing useful to show mid-flight.
      const id = pending.add(w.path.split(/[\\/]/).pop() ?? w.path)
      pending.fail([id], (err as Error).message)
    }
  }

  return (
    // Both themes get a pane (user-directed, 2026-08-02): the classic rail is pure black, so
    // three unbounded sections stacked on it read as one undifferentiated column. `surface-card`
    // is the app's existing matte material (--bg-2 fill, hairline border) — the same one the
    // dashboard cards and the editor shell use — so this introduces no new material.
    <div
      className={`flex flex-col gap-1.5 rounded-r3 p-2.5 ${dynamic ? 'glass-panel' : 'surface-card'}`}
    >
      <div className="flex items-center justify-between">
        <SectionLabel>Repos</SectionLabel>
        <div className="flex items-center gap-1">
          <IconBtn
            aria-label="Link repo"
            title="Link a local repo"
            size="xs"
            onClick={() => void link()}
          >
            <FolderGit2 size={13} />
          </IconBtn>
        </div>
      </div>
      {workspaces.map((w) => (
        <div key={w.path} className="flex items-center gap-1">
          {/* Blue name, amber dot (user-directed, 2026-08-01) — the two were the wrong way
              round. The repo NAME is an identifier and never a problem, so it takes the same
              signal blue as every other identifier in the app; the dirty dot IS the thing
              wanting attention, so it takes the attention colour the name was wearing.
              The row itself carries no box (user-directed, 2026-08-02): a blue-bordered filled
              card per repo made the rail's densest list its loudest object, and the blue was
              already saying "identifier" through the name. Hover is the only fill now — the
              border stays declared-but-transparent so the row does not shift 1px on hover. */}
          <div className="min-w-0 flex-1 rounded-r2 border border-transparent px-2 py-1.5 transition-colors hover:border-hair hover:bg-hair/50">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-xs font-medium text-signal">
                {w.path.split(/[\\/]/).pop()}
              </span>
              {w.dirty && (
                <span title="Uncommitted changes" className="shrink-0 text-[10px] text-defect">
                  ●
                </span>
              )}
              {w.worktreePath && (
                <span className="shrink-0 rounded-r1 border border-hair2 px-1 font-mono text-[9.5px] uppercase tracking-wide text-mute">
                  worktree
                </span>
              )}
            </div>
            <div
              title={w.currentRef}
              className="mt-0.5 truncate text-left font-mono text-[11px] text-mute"
              dir="rtl"
            >
              {/* dir=rtl truncates the START of the ref, keeping the topic segment that
                  carries the meaning — branch names here read <prefix>/<topic>. text-left
                  keeps the line pinned to the left at any length: direction picks which end
                  the ellipsis lands on, text-align is a separate axis and defaults to
                  following direction (right, for rtl) unless overridden. */}
              <span dir="ltr">{w.currentRef}</span>
            </div>
          </div>
          {mode !== 'review' && (
            <>
              <IconBtn
                aria-label="Unlink repo"
                title="Unlink repo"
                size="xs"
                className="hover:text-danger"
                onClick={() => void unlink(w)}
              >
                <Unlink size={12} />
              </IconBtn>
              <RepoGraphControl repoPath={w.path} />
            </>
          )}
        </div>
      ))}
      {/* usePendingDisplay stays true briefly after `loaded` flips, so the guard here is
          workspaces.length === 0 (not !loaded) to keep the skeleton exclusive with the chip
          list rather than cancelling that minimum-hold. */}
      {showSkeleton && workspaces.length === 0 && <SkeletonRows count={1} />}
      {pending.items.map((p) => (
        <div key={p.id} className="flex items-center gap-1">
          <div
            title={p.error}
            className={`min-w-0 flex-1 rounded-r2 border px-2 py-1.5 ${
              p.error ? 'border-danger/60 bg-danger/10' : 'border-signal/30 bg-hair/50'
            }`}
          >
            {/* wrapped in a block div (matching the real chip above): `truncate` on a bare
                inline span does nothing — overflow does not apply to inline non-replaced boxes,
                so a long repo name would render nowrap and spill out of the 216px rail. */}
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={`truncate font-mono text-xs font-medium ${
                  p.error ? 'text-danger line-through' : 'text-signal'
                }`}
              >
                {p.name}
              </span>
            </div>
            {p.error ? (
              <div className="mt-0.5 truncate text-[11px] text-danger">{p.error}</div>
            ) : (
              <Skeleton className="mt-1 h-2 w-[70%]" />
            )}
          </div>
          {p.error && (
            <IconBtn
              aria-label={`Dismiss ${p.name} error`}
              title="Dismiss"
              size="xs"
              onClick={() => pending.dismiss(p.id)}
            >
              ×
            </IconBtn>
          )}
        </div>
      ))}
      {/* Bound PRs are not listed here: the Pull request section is their home, and naming
          them twice was the problem this rail had. Linking (Link PR / Find PRs) lives there
          too now — see PrCompanionSection. */}
      {refs.map((r, i) => (
        <Chip
          key={`${r.remote ?? 'ref'}-${i}`}
          tone="neutral"
          title={`${r.remote ?? 'unknown remote'} @ ${r.branch ?? '?'} ${r.commit ?? ''} — imported reference; link a local checkout to work with the code`}
        >
          {(r.remote ?? 'repo')
            .split('/')
            .pop()
            ?.replace(/\.git$/, '')}{' '}
          @ {r.commit?.slice(0, 7) ?? '?'} · unlinked
        </Chip>
      ))}
    </div>
  )
}
