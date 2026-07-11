import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'
import type { BundleWorkspaceRef } from '../../../shared/bundle'
import { FolderGit2, Unlink } from 'lucide-react'
import { Chip, IconBtn } from './ui'
import { RepoGraphControl } from './RepoGraphControl'

export function HeaderRepos({ slug }: { slug: string }): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [refs, setRefs] = useState<BundleWorkspaceRef[]>([])
  const reload = useCallback(
    (): Promise<void> => window.argus.workspaces.list(slug).then(setWorkspaces),
    [slug]
  )
  useEffect(() => {
    void reload()
  }, [reload])
  useEffect(() => {
    void window.argus.workspaces.refs(slug).then(setRefs)
  }, [slug])

  async function link(): Promise<void> {
    const p = await window.argus.workspaces.pick()
    if (p) {
      await window.argus.workspaces.link(slug, p)
      await reload()
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {workspaces.map((w) => (
        <span key={w.path} className="flex items-center gap-1">
          <Chip tone={w.worktreePath ? 'defect' : 'signal'}>
            {w.path.split(/[\\/]/).pop()} @ {w.currentRef}
            {w.dirty ? ' ●' : ''}
            {w.worktreePath ? ' · worktree' : ''}
          </Chip>
          <IconBtn
            aria-label="Unlink repo"
            title="Unlink repo"
            className="h-5 w-5 hover:text-danger"
            onClick={() => void window.argus.workspaces.unlink(slug, w.path).then(reload)}
          >
            <Unlink size={12} />
          </IconBtn>
          <RepoGraphControl repoPath={w.path} />
        </span>
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
      <IconBtn aria-label="Link repo" title="Link a local repo" onClick={() => void link()}>
        <FolderGit2 size={14} />
      </IconBtn>
    </div>
  )
}
