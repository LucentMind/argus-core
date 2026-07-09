import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'
import { Btn, Chip } from './ui'

export function WorkspacesStrip({ slug }: { slug: string }): React.JSX.Element {
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
    <div className="flex flex-wrap items-center gap-2 border-b border-hair bg-deep px-4 py-1.5">
      {workspaces.map((w) => (
        <span key={w.path} className="flex items-center gap-1.5">
          <Chip tone={w.worktreePath ? 'defect' : 'signal'}>
            {w.path.split(/[\\/]/).pop()} @ {w.currentRef}
            {w.dirty ? ' ●' : ''}
            {w.worktreePath ? ' · worktree' : ''}
          </Chip>
          <button
            className="text-xs text-mute transition-colors hover:text-danger"
            title="Unlink repo"
            onClick={() => void window.argus.workspaces.unlink(slug, w.path).then(reload)}
          >
            ×
          </button>
        </span>
      ))}
      <Btn variant="ghost" className="ml-auto" onClick={() => void link()}>
        Link repo…
      </Btn>
    </div>
  )
}
