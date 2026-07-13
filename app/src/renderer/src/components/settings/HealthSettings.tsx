import { useEffect, useRef, useState } from 'react'
import { CircleX, MonitorCheck, RotateCcw } from 'lucide-react'
import {
  HEALTH_CATEGORIES,
  HEALTH_CATEGORY_LABELS,
  type HealthCheckResult,
  type HealthRow
} from '../../../../shared/health'
import { SettingsSection } from './settingsLayout'
import { Btn, Chip, IconBtn } from '../ui'

export function HealthSettings(): React.JSX.Element {
  const [rows, setRows] = useState<HealthRow[]>([])
  const [results, setResults] = useState<Record<string, HealthCheckResult | 'running'>>({})
  const [running, setRunning] = useState(false)
  // In-flight runs per row (results carry no run id). A result is applied only
  // when it belongs to the latest run, so a stale result from a superseded run
  // can't overwrite a fresh 'running' chip.
  const pending = useRef<Record<string, number>>({})

  function markRunning(ids: string[]): void {
    for (const id of ids) pending.current[id] = (pending.current[id] ?? 0) + 1
    setResults((m) => ({
      ...m,
      ...Object.fromEntries(ids.map((id) => [id, 'running' as const]))
    }))
  }

  useEffect(() => {
    let mounted = true
    const off = window.argus.health.onResult((r: HealthCheckResult) => {
      // count down this row's in-flight runs; only the last one's result lands
      const left = Math.max(0, (pending.current[r.id] ?? 1) - 1)
      pending.current[r.id] = left
      if (left === 0) setResults((m) => ({ ...m, [r.id]: r }))
    })
    void window.argus.health.list().then((rs: HealthRow[]) => {
      if (!mounted) return
      setRows(rs)
      markRunning(rs.map((r) => r.id))
      setRunning(true)
      void window.argus.health.run().finally(() => mounted && setRunning(false))
    })
    return () => {
      mounted = false
      off()
    }
  }, [])

  function runAll(): void {
    markRunning(rows.map((r) => r.id))
    setRunning(true)
    void window.argus.health.run().finally(() => setRunning(false))
  }

  function runOne(id: string): void {
    markRunning([id])
    void window.argus.health.run([id])
  }

  return (
    <div className="flex flex-col gap-4">
      {HEALTH_CATEGORIES.map((category) => {
        const catRows = rows.filter((r) => r.category === category)
        if (catRows.length === 0) return null
        return (
          <SettingsSection key={category} title={HEALTH_CATEGORY_LABELS[category]}>
            {catRows.map((row) => {
              const r = results[row.id]
              return (
                <div key={row.id} className="flex items-start gap-3 px-3 py-2">
                  <span className="w-56 shrink-0">{row.label}</span>
                  {r === 'running' || r == null ? (
                    <Chip tone="neutral">checking…</Chip>
                  ) : r.ok ? (
                    <span title="ok" className="flex shrink-0 items-center">
                      <MonitorCheck size={16} role="img" aria-label="ok" className="text-signal" />
                    </span>
                  ) : (
                    <span title="fail" className="flex shrink-0 items-center">
                      <CircleX size={16} role="img" aria-label="fail" className="text-danger" />
                    </span>
                  )}
                  <span className="text-dim min-w-0 flex-1 text-sm">
                    {r !== 'running' && r != null && (
                      <>
                        <span className="break-all">{r.detail}</span>
                        {!r.ok && r.fixHint && <div className="text-mute text-xs">{r.fixHint}</div>}
                      </>
                    )}
                  </span>
                  <IconBtn
                    aria-label={`re-run · ${row.id}`}
                    title="Re-run check"
                    onClick={() => runOne(row.id)}
                  >
                    <RotateCcw size={14} />
                  </IconBtn>
                </div>
              )
            })}
          </SettingsSection>
        )
      })}
      {rows.length === 0 && (
        <SettingsSection title="Health checks">
          <div className="text-dim p-3 text-sm">loading…</div>
        </SettingsSection>
      )}
      <div>
        <Btn variant="outline" onClick={runAll} disabled={running}>
          Run all checks
        </Btn>
      </div>
    </div>
  )
}
