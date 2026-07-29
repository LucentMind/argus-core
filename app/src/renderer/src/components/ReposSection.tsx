import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'
import type { BundleWorkspaceRef } from '../../../shared/bundle'
import { FolderGit2, Unlink } from 'lucide-react'
import { Chip, IconBtn, SectionLabel } from './ui'
import { RepoGraphControl } from './RepoGraphControl'
import { reposStore } from '../lib/reposStore'
import { invalidateRepoSnippets } from '../lib/snippetCache'
import { DEFAULT_MODE, type ModeId } from '../../../shared/modes'

/** Linked repos as evidence: the repo chips (moved here from the header), with
 *  link/unlink and the graph control. Individual files are not listed — code is
 *  cited per line via [repo/path:line] citations. */
export function ReposSection({
  slug,
  mode = DEFAULT_MODE,
  headerExtra
}: {
  slug: string
  /** Review mode drops repo-management affordances (unlink, code graph): the repo under
   *  review is not the user's to manage from here. Defaults to investigation behavior. */
  mode?: ModeId
  /** rendered at the right edge of the Repos header (e.g. the pane-collapse button) */
  headerExtra?: React.ReactNode
}): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [refs, setRefs] = useState<BundleWorkspaceRef[]>([])

  const reload = useCallback((): Promise<void> => {
    // keep the citation domain + snippet cache in sync with link state
    invalidateRepoSnippets(slug)
    void reposStore.load(slug)
    return window.argus.workspaces.list(slug).then(setWorkspaces)
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
    if (p) {
      await window.argus.workspaces.link(slug, p)
      await reload()
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <SectionLabel>Repos</SectionLabel>
        <div className="flex items-center gap-1">
          <IconBtn
            aria-label="Link repo"
            title="Link a local repo"
            className="h-5 w-5"
            onClick={() => void link()}
          >
            <FolderGit2 size={13} />
          </IconBtn>
          {headerExtra}
        </div>
      </div>
      {workspaces.map((w) => (
        <div key={w.path} className="flex items-center gap-1">
          <div className="min-w-0 flex-1 rounded-r2 border border-defect/30 bg-hair/50 px-2 py-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-xs font-medium text-defect">
                {w.path.split(/[\\/]/).pop()}
              </span>
              {w.dirty && (
                <span title="Uncommitted changes" className="shrink-0 text-[10px] text-signal">
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
                className="h-5 w-5 hover:text-danger"
                onClick={() => void window.argus.workspaces.unlink(slug, w.path).then(reload)}
              >
                <Unlink size={12} />
              </IconBtn>
              <RepoGraphControl repoPath={w.path} />
            </>
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
