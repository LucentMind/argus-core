import { useCallback, useEffect, useState } from 'react'
import { Waypoints } from 'lucide-react'
import type { GraphStatusRow } from '../../../shared/types'
import { IconBtn } from './ui'

export function RepoGraphControl({ repoPath }: { repoPath: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<GraphStatusRow[]>([])
  const [scope, setScope] = useState('')
  const [missing, setMissing] = useState(false)
  const [installLog, setInstallLog] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)

  const reload = useCallback(
    (): Promise<void> => window.argus.graph.status(repoPath).then(setRows),
    [repoPath]
  )
  useEffect(() => {
    void reload()
    const offB = window.argus.graph.onBuilding((p) => {
      if (p.repoPath === repoPath) void reload()
    })
    const offC = window.argus.graph.onChanged((p) => {
      if (p.repoPath === repoPath) void reload()
    })
    return () => {
      offB()
      offC()
    }
  }, [repoPath, reload])

  const building = rows.some((r) => r.status === 'building')
  const built = rows.find((r) => r.status === 'ok' || r.status === 'failed')

  async function build(): Promise<void> {
    setBuildError(null)
    try {
      const res = await window.argus.graph.build(repoPath, scope.trim() ? scope.trim() : null)
      if (res.missing) setMissing(true)
      else void reload()
    } catch (err) {
      // main-side validation (hostile scope, missing repo path) rejects the invoke
      setBuildError((err as Error).message)
    }
  }

  async function install(): Promise<void> {
    setInstalling(true)
    const r = await window.argus.graph.install()
    setInstalling(false)
    if (r.ok) {
      setMissing(false)
      setInstallLog(null)
      void build()
    } else {
      setInstallLog(r.log)
    }
  }

  return (
    <span className="relative">
      <IconBtn
        aria-label="Code graph"
        title="Code graph"
        className={building ? 'animate-pulse' : built?.status === 'failed' ? 'text-danger' : ''}
        onClick={() => setOpen((o) => !o)}
      >
        <Waypoints size={12} />
      </IconBtn>
      {open && (
        <div className="absolute left-0 top-6 z-20 w-64 rounded-r2 border border-hair bg-deep p-2 text-xs shadow-lg">
          {rows.map((r) => (
            <div key={r.scopeKey} className="mb-1">
              {r.status === 'building' && <span>building…</span>}
              {r.status === 'none' && <span>no graph yet</span>}
              {r.status === 'ok' && (
                <span>
                  graph @ {r.commit?.slice(0, 7)}
                  {r.scope ? ` · ${r.scope}` : ''}
                  {r.behind ? ` · ${r.behind} behind` : ''}
                  {r.nodeCount != null ? ` · ${r.nodeCount} nodes` : ''}
                </span>
              )}
              {r.status === 'failed' && (
                <span className="text-danger">
                  build failed{r.error ? ` — ${r.error.slice(0, 120)}` : ''}
                </span>
              )}
            </div>
          ))}
          {missing ? (
            <div>
              <div className="mb-1">graphify not found.</div>
              {installLog ? (
                <div className="whitespace-pre-wrap text-danger">{installLog}</div>
              ) : (
                <button
                  className="rounded-r2 border border-hair px-2 py-0.5 hover:bg-hair"
                  disabled={installing}
                  onClick={() => void install()}
                >
                  {installing ? 'Installing…' : 'Install graphify'}
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <input
                className="rounded-r2 border border-hair bg-transparent px-1 py-0.5"
                placeholder="limit to subpath (optional)"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              />
              <button
                className="rounded-r2 border border-hair px-2 py-0.5 hover:bg-hair"
                disabled={building}
                onClick={() => void build()}
              >
                {built?.status === 'ok' ? 'Refresh graph' : 'Build code graph'}
              </button>
              {buildError && <div className="text-danger">{buildError}</div>}
            </div>
          )}
        </div>
      )}
    </span>
  )
}
