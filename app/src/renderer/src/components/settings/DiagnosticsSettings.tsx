import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type {
  DiagnosticsObject,
  DiagnosticsSnapshot,
  SidecarHealth,
  SidecarStatus
} from '../../../../shared/diagnostics'
import { SettingsSection } from './settingsLayout'

// SettingsSection's real signature (settingsLayout.tsx:53) is
// { title, subtitle?, action?, count?, collapsed?, onToggle?, children } — it takes
// no icon prop. Do not add one; match the existing sections.

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb.toFixed(0)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

// `n.toFixed(1)` alone mis-rounds values like 2.05: the nearest double to 2.05 is
// very slightly below it (2.049999999999999822…), so `.toFixed(1)` reads that as
// "2.0" per spec even though the intended value rounds to "2.1". Multiplying
// first lands on an exact double for the CPU percentages this renders, sidestepping
// the mis-round.
function formatPercent(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1)
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Status-specific reason, appended to the honest "unavailable" headline below. */
function unavailableHint(status: SidecarStatus): string {
  switch (status) {
    case 'disabled':
      return 'No sidecar binary is available for this platform.'
    case 'unavailable':
      return 'The sidecar crashed repeatedly and stopped retrying automatically.'
    case 'degraded':
      return 'The sidecar is restarting after a failure.'
    case 'starting':
      return 'The sidecar is starting.'
    case 'healthy':
      return ''
  }
}

/**
 * There are no Electron-only rows to fall back to — this feature does not
 * synthesize process data from anything but the sidecar. When the sidecar
 * isn't healthy, say so plainly and why, rather than implying a degraded
 * mode that doesn't exist.
 */
function unavailableMessage(sidecar: SidecarHealth): string {
  const hint = unavailableHint(sidecar.status)
  const error = sidecar.lastError ? ` (${sidecar.lastError})` : ''
  return `Process diagnostics are unavailable. ${hint}${error}`
}

function Tile(props: {
  testId: string
  label: string
  value: string
  sub: string
}): React.JSX.Element {
  return (
    <div className="flex-1 rounded-r3 border border-hair p-3">
      <div className="text-[11px] uppercase tracking-wide text-mute">{props.label}</div>
      <div data-testid={props.testId} className="mt-1 font-mono text-2xl">
        {props.value}
      </div>
      <div className="mt-1 text-xs text-mute">{props.sub}</div>
    </div>
  )
}

function ObjectRow({ o }: { o: DiagnosticsObject }): React.JSX.Element {
  const unattributed = o.kind === 'unattributed'
  return (
    <tr
      data-testid="diag-object-row"
      data-kind={o.kind}
      data-procs={o.processCount}
      className={`border-t border-hair${unattributed ? ' text-mute' : ''}`}
    >
      <td className="px-3 py-1">
        {o.label}
        {o.inferred ? (
          <span className="ml-2 text-xs text-mute" title="Inferred from the command line">
            inferred
          </span>
        ) : null}
      </td>
      <td className="px-3 py-1 text-right font-mono">{formatPercent(o.cpuPercent)}%</td>
      <td className="px-3 py-1 text-right font-mono">{formatBytes(o.rssBytes)}</td>
      <td className="px-3 py-1 text-right font-mono text-mute">
        {unattributed ? '—' : formatUptime(o.uptimeMs)}
      </td>
      <td className="px-3 py-1 text-right font-mono text-mute">{o.processCount}</td>
    </tr>
  )
}

export default function DiagnosticsSettings(): React.JSX.Element {
  const [snap, setSnap] = useState<DiagnosticsSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    const off = window.argus.diagnostics.onSample((s) => {
      if (alive) setSnap(s)
    })
    void window.argus.diagnostics.latest().then((s) => {
      if (alive && s) setSnap(s)
    })
    void window.argus.diagnostics.subscribe()
    return () => {
      alive = false
      off()
      void window.argus.diagnostics.unsubscribe()
    }
  }, [])

  if (!snap) {
    return (
      <SettingsSection title="Diagnostics">
        <p className="p-3 text-sm text-mute">Waiting for the first sample…</p>
      </SettingsSection>
    )
  }

  const healthy = snap.sidecar.status === 'healthy'
  const hasTree = snap.tree.length > 0

  // No working sidecar and nothing to show from a past one: a full panel
  // explaining why, instead of empty tiles and an empty table.
  if (!healthy && !hasTree) {
    return (
      <SettingsSection title="Diagnostics">
        <span data-testid="diag-readat" hidden>
          {snap.readAt}
        </span>
        <div className="m-3 flex items-start gap-2 rounded-r3 border border-hair p-3 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span className="flex-1">{unavailableMessage(snap.sidecar)}</span>
          <button
            type="button"
            className="rounded-r2 border border-hair px-2 py-1 text-xs"
            onClick={() => void window.argus.diagnostics.retrySidecar()}
          >
            Retry
          </button>
        </div>
      </SettingsSection>
    )
  }

  return (
    <>
      {/* Liveness hook for the CDP gate. Every field a human can see is a rounded
          string that legitimately repeats between two samples on an idle machine,
          so none of them can distinguish "streaming" from "frozen after one push".
          readAt is strictly monotonic per push, which is exactly the assertion. */}
      <span data-testid="diag-readat" hidden>
        {snap.readAt}
      </span>
      <SettingsSection title="Footprint" subtitle="Live totals across every process Argus runs.">
        {!healthy && (
          <div className="m-3 flex items-center gap-2 rounded-r3 border border-hair p-3 text-sm">
            <AlertTriangle size={16} className="shrink-0" />
            <span className="flex-1">{unavailableMessage(snap.sidecar)}</span>
            <button
              type="button"
              className="rounded-r2 border border-hair px-2 py-1 text-xs"
              onClick={() => void window.argus.diagnostics.retrySidecar()}
            >
              Retry
            </button>
          </div>
        )}
        <div className="flex gap-3 p-3">
          <Tile
            testId="diag-cpu"
            label="CPU"
            value={`${formatPercent(snap.footprint.cpuPercent)}%`}
            sub={`of ${snap.cores} cores`}
          />
          <Tile
            testId="diag-rss"
            label="Resident memory"
            value={formatBytes(snap.footprint.rssBytes)}
            sub={`peak ${formatBytes(snap.footprint.peakRssBytes)}`}
          />
          <Tile
            testId="diag-procs"
            label="Processes"
            value={String(snap.footprint.processCount)}
            sub={`${snap.footprint.starts} starts · ${snap.footprint.exits} exits`}
          />
        </div>
      </SettingsSection>

      {snap.objects.length > 0 && (
        <SettingsSection
          title="Argus objects"
          subtitle="Every process attributed to the driver, connector, or window that owns it. These rows account for the footprint above (displayed values are independently rounded, so they may not add up exactly)."
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-mute">
                <th className="px-3 py-1">Object</th>
                <th className="px-3 py-1 text-right">CPU</th>
                <th className="px-3 py-1 text-right">Memory</th>
                <th className="px-3 py-1 text-right">Uptime</th>
                <th className="px-3 py-1 text-right">Procs</th>
              </tr>
            </thead>
            <tbody>
              {snap.objects.map((o) => (
                <ObjectRow key={o.id} o={o} />
              ))}
            </tbody>
          </table>
        </SettingsSection>
      )}

      <SettingsSection
        title="Process tree"
        subtitle="Every process descending from Argus, in tree order."
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-mute">
              <th className="px-3 py-1">Process</th>
              <th className="px-3 py-1">PID</th>
              <th className="px-3 py-1 text-right">CPU</th>
              <th className="px-3 py-1 text-right">Memory</th>
              <th className="px-3 py-1 text-right">Uptime</th>
            </tr>
          </thead>
          <tbody>
            {snap.tree.map((p) => (
              <tr key={`${p.pid}:${p.startTimeMs}`} className="border-t border-hair">
                <td className="px-3 py-1" style={{ paddingLeft: `${12 + p.depth * 14}px` }}>
                  {p.name}
                  {p.electronType ? (
                    <span className="ml-2 text-xs text-mute">{p.electronType}</span>
                  ) : null}
                </td>
                <td className="px-3 py-1 font-mono text-xs text-mute">{p.pid}</td>
                <td className="px-3 py-1 text-right font-mono">{formatPercent(p.cpuPercent)}%</td>
                <td className="px-3 py-1 text-right font-mono">{formatBytes(p.residentBytes)}</td>
                <td className="px-3 py-1 text-right font-mono text-mute">
                  {formatUptime(p.uptimeMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsSection>
    </>
  )
}
