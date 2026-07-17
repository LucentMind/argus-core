import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'
import type { BundleWorkspaceRef } from '../../../shared/bundle'
import { FolderGit2, Unlink } from 'lucide-react'
import { Chip, IconBtn, SectionLabel } from './ui'
import { RepoGraphControl } from './RepoGraphControl'
import { reposStore } from '../lib/reposStore'
import { invalidateRepoSnippets } from '../lib/snippetCache'

/** Linked repos as evidence: the repo chips (moved here from the header), with
 *  link/unlink and the graph control. Individual files are not listed — code is
 *  cited per line via [repo/path:line] citations. */
export function ReposSection({ slug }: { slug: string }): React.JSX.Element {
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
        <IconBtn
          aria-label="Link repo"
          title="Link a local repo"
          className="h-5 w-5"
          onClick={() => void link()}
        >
          <FolderGit2 size={13} />
        </IconBtn>
      </div>
      {workspaces.map((w) => (
        <div key={w.path} className="flex items-center gap-1">
          <Chip tone={w.worktreePath ? 'defect' : 'signal'}>
            {w.path.split(/[\\/]/).pop()} @ {w.currentRef}
            {w.dirty ? ' ●' : ''}
            {w.worktreePath ? ' · worktree' : ''}
          </Chip>
          <span className="flex-1" />
          <IconBtn
            aria-label="Unlink repo"
            title="Unlink repo"
            className="h-5 w-5 hover:text-danger"
            onClick={() => void window.argus.workspaces.unlink(slug, w.path).then(reload)}
          >
            <Unlink size={12} />
          </IconBtn>
          <RepoGraphControl repoPath={w.path} />
        </div>
      ))}
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
