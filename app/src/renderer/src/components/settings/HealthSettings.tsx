import { useEffect, useState } from 'react'
import type { HealthCheckResult, HealthRow } from '../../../../shared/health'
import { SettingsSection } from './settingsLayout'
import { Btn, Chip } from '../ui'

export function HealthSettings(): React.JSX.Element {
  const [rows, setRows] = useState<HealthRow[]>([])
  const [results, setResults] = useState<Record<string, HealthCheckResult | 'running'>>({})
  const [running, setRunning] = useState(false)

  useEffect(() => {
    const off = window.argus.health.onResult((r: HealthCheckResult) =>
      setResults((m) => ({ ...m, [r.id]: r }))
    )
    void window.argus.health.list().then((rs: HealthRow[]) => {
      setRows(rs)
      setResults(Object.fromEntries(rs.map((r) => [r.id, 'running' as const])))
      setRunning(true)
      void window.argus.health.run().finally(() => setRunning(false))
    })
    return off
  }, [])

  function runAll(): void {
    setResults(Object.fromEntries(rows.map((r) => [r.id, 'running' as const])))
    setRunning(true)
    void window.argus.health.run().finally(() => setRunning(false))
  }

  function runOne(id: string): void {
    setResults((m) => ({ ...m, [id]: 'running' }))
    void window.argus.health.run([id])
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title="Health checks">
        {rows.map((row) => {
          const r = results[row.id]
          return (
            <div key={row.id} className="flex items-start gap-3 px-3 py-2">
              <span className="w-56 shrink-0">{row.label}</span>
              {r === 'running' || r == null ? (
                <Chip tone="neutral">checking…</Chip>
              ) : r.ok ? (
                <Chip tone="review">ok</Chip>
              ) : (
                <Chip tone="danger">fail</Chip>
              )}
              <span className="text-dim min-w-0 flex-1 text-sm">
                {r !== 'running' && r != null && (
                  <>
                    <span className="break-all">{r.detail}</span>
                    {!r.ok && r.fixHint && <div className="text-mute text-xs">{r.fixHint}</div>}
                  </>
                )}
              </span>
              <Btn variant="ghost" onClick={() => runOne(row.id)} aria-label={`re-run · ${row.id}`}>
                ↻
              </Btn>
            </div>
          )
        })}
        {rows.length === 0 && <div className="text-dim p-3 text-sm">loading…</div>}
      </SettingsSection>
      <div>
        <Btn variant="outline" onClick={runAll} disabled={running}>
          Run all checks
        </Btn>
      </div>
    </div>
  )
}
