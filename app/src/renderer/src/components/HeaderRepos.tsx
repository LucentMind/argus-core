import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'
import { Chip } from './ui'

export function HeaderRepos({ slug }: { slug: string }): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const reload = useCallback(
    (): Promise<void> => window.argus.workspaces.list(slug).then(setWorkspaces),
    [slug]
  )
  useEffect(() => {
    void reload()
  }, [reload])

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
          <button
            aria-label="Unlink repo"
            title="Unlink repo"
            className="text-xs text-mute transition-colors hover:text-danger"
            onClick={() => void window.argus.workspaces.unlink(slug, w.path).then(reload)}
          >
            ×
          </button>
        </span>
      ))}
      <button
        className="rounded-r2 px-1.5 py-0.5 text-xs text-dim transition-colors hover:bg-hair hover:text-ink"
        onClick={() => void link()}
      >
        + repo
      </button>
    </div>
  )
}
