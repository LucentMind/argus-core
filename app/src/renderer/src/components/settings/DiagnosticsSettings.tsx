import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  DIAGNOSTICS_BUCKET_MS,
  type DiagnosticsHistory,
  type DiagnosticsHistorySeries,
  type DiagnosticsObject,
  type DiagnosticsSeries,
  type DiagnosticsSnapshot,
  type SidecarHealth,
  type SidecarStatus
} from '../../../../shared/diagnostics'
import { bridgeBuckets, lastIndexWithData, niceMax } from '../../lib/timeline'
import { Sparkline } from './diagnostics/Sparkline'
import { TimelineChart } from './diagnostics/TimelineChart'
import { SettingsSection } from './settingsLayout'

/** Ended rows shown before the overflow count. Uncapped, a crash-loop would push sixty
 *  rows into the table and bury the live ones. */
const ENDED_ROW_LIMIT = 8

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

const WINDOWS = [
  { id: '5m', ms: 5 * 60_000 },
  { id: '15m', ms: 15 * 60_000 },
  { id: '30m', ms: 30 * 60_000 },
  { id: '1h', ms: 60 * 60_000 }
] as const

type WindowId = (typeof WINDOWS)[number]['id']

const DEFAULT_WINDOW_ID: WindowId = '15m'
const DEFAULT_WINDOW_MS = WINDOWS.find((w) => w.id === DEFAULT_WINDOW_ID)!.ms

/**
 * The same short form as a WINDOWS id ("5m", "1h"), derived from an actual payload size
 * rather than looked up from the selector — so a header built from this and a row built
 * from the same payload can never disagree, even mid-refetch when the selector has
 * already moved on to a window whose data hasn't arrived yet.
 */
function formatWindowMs(ms: number): string {
  const minutes = ms / 60_000
  return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`
}

/**
 * The history poll interval, deliberately the bucket size rather than the 1s sample push.
 *
 * Nothing arriving inside a bucket can change anything except that bucket's own partial
 * value, so polling faster only re-clones the payload. The visible consequence: the
 * rightmost point lags up to 5s behind the tiles above it. The tiles are the
 * instantaneous reading; the chart is the interval one.
 */
const HISTORY_REFRESH_MS = 5_000

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

/**
 * The rows to render below the live objects: the ones that ran inside the window and
 * have since exited.
 *
 * Requires BOTH `!s.live` and absence from the live id set. `live` is derived inside the
 * ring from its last recorded bucket, while the id set comes from the 1Hz snapshot push;
 * the two are fetched on different cadences and can disagree for a tick. Demanding both
 * means a row can never appear in two groups at once.
 *
 * `unattributed` is excluded explicitly: it is synthetic and exists whenever a snapshot
 * does, so it can never legitimately be an ended row.
 */
function splitRows(
  objects: DiagnosticsObject[],
  history: DiagnosticsHistory | null
): { ended: DiagnosticsHistorySeries[]; endedOverflow: number } {
  const liveIds = new Set(objects.map((o) => o.id))
  const ended = (history?.objects ?? [])
    .filter((s) => !s.live && !liveIds.has(s.id) && s.id !== 'unattributed')
    .sort((a, b) => {
      // Most recently finished first; id breaks ties so the order is deterministic
      // rather than dependent on array insertion order.
      const d = lastIndexWithData(b.cpuPercent) - lastIndexWithData(a.cpuPercent)
      return d !== 0 ? d : a.id.localeCompare(b.id)
    })
  return {
    ended: ended.slice(0, ENDED_ROW_LIMIT),
    endedOverflow: Math.max(0, ended.length - ENDED_ROW_LIMIT)
  }
}

function ObjectRow({
  o,
  series,
  max,
  bridge
}: {
  o: DiagnosticsObject
  series: DiagnosticsSeries | null
  max: number
  bridge: number
}): React.JSX.Element {
  const unattributed = o.kind === 'unattributed'
  return (
    <tr
      data-testid="diag-object-row"
      data-kind={o.kind}
      data-procs={o.processCount}
      data-orphan={o.orphan}
      data-inferred={o.inferred}
      className={`border-t border-hair${unattributed ? ' text-mute' : ''}`}
    >
      <td className="px-3 py-1">
        {o.label}
        {o.owner ? <span className="ml-2 text-xs text-mute">{o.owner}</span> : null}
        {o.inferred ? (
          <span className="ml-2 text-xs text-mute" title="Inferred from the command line">
            inferred
          </span>
        ) : null}
        {o.orphan ? (
          <span
            className="ml-2 text-xs text-mute"
            title="The case or session that started this process is gone"
          >
            orphaned
          </span>
        ) : null}
      </td>
      <td className="px-3 py-1">
        <Sparkline
          series={series ?? []}
          max={max}
          bridge={bridge}
          label={`CPU history · ${o.label}`}
        />
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

function EndedObjectRow({
  s,
  max,
  bridge
}: {
  s: DiagnosticsHistorySeries
  max: number
  bridge: number
}): React.JSX.Element {
  return (
    <tr
      data-testid="diag-object-row-ended"
      data-kind={s.kind}
      className="border-t border-hair text-mute"
    >
      <td className="px-3 py-1">
        {s.label}
        <span className="ml-2 text-xs" title="This process has exited; its history is kept">
          ended
        </span>
      </td>
      <td className="px-3 py-1">
        <Sparkline
          series={s.cpuPercent}
          max={max}
          bridge={bridge}
          label={`CPU history · ${s.label}`}
        />
      </td>
      {/* An ended row has no current reading. Em-dashes rather than a stale last value,
          which would read as live. */}
      <td className="px-3 py-1 text-right font-mono">—</td>
      <td className="px-3 py-1 text-right font-mono">—</td>
      <td className="px-3 py-1 text-right font-mono">—</td>
      <td className="px-3 py-1 text-right font-mono">—</td>
    </tr>
  )
}

export default function DiagnosticsSettings(): React.JSX.Element {
  const [snap, setSnap] = useState<DiagnosticsSnapshot | null>(null)
  const [windowId, setWindowId] = useState<WindowId>(DEFAULT_WINDOW_ID)
  const [history, setHistory] = useState<DiagnosticsHistory | null>(null)

  const healthy = snap?.sidecar.status === 'healthy'
  const windowMs = WINDOWS.find((w) => w.id === windowId)?.ms ?? DEFAULT_WINDOW_MS

  // Both depend only on `history`, which changes at most once per HISTORY_REFRESH_MS —
  // not on every 1Hz snapshot push. Without memoizing, a 1h window's flatMap allocates
  // ~46,000 array entries a second for no reason: nothing here reads `snap`.
  const seriesById = useMemo(
    () => new Map((history?.objects ?? []).map((s) => [s.id, s])),
    [history]
  )
  // ONE axis maximum across every sparkline in the table, so a tall spike in one row
  // reads as taller than a flat line in another. Per-row autoscaling would make every
  // row look equally busy — the exact opposite of what the column is for.
  const sparkMax = useMemo(
    () =>
      niceMax(
        [...seriesById.values()].flatMap((s) => s.cpuPercent),
        'percent'
      ),
    [seriesById]
  )

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

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const h = await window.argus.diagnostics.history(windowMs)
      if (alive) setHistory(h)
    }
    void load()
    const timer = setInterval(() => void load(), HISTORY_REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
    // `healthy` is a boolean, so this only re-runs on a real transition — not on every
    // 1Hz snapshot push. A sidecar coming back up should refill the chart promptly.
  }, [windowMs, healthy])

  if (!snap) {
    return (
      <SettingsSection title="Diagnostics">
        <p className="p-3 text-sm text-mute">Waiting for the first sample…</p>
      </SettingsSection>
    )
  }

  const hasTree = snap.tree.length > 0

  const { ended, endedOverflow } = splitRows(snap.objects, history)
  const sparkBridge = bridgeBuckets(history?.bucketMs ?? DIAGNOSTICS_BUCKET_MS)
  // The selected window (`windowId`) and the fetched payload (`history`) are updated on
  // different cadences — the selector changes instantly, the payload only after the next
  // IPC round trip resolves. Deriving the label from the payload itself, rather than from
  // `windowId`, means the header can never claim a window the rows underneath don't
  // actually hold. Falls back to the selector only when there is no payload at all yet.
  const windowLabel = history ? formatWindowMs(history.bucketCount * history.bucketMs) : windowId

  const windowSelector = (
    <div
      role="group"
      aria-label="Timeline window"
      className="flex shrink-0 overflow-hidden rounded-r2 border border-hair"
    >
      {WINDOWS.map((w, i) => (
        <button
          key={w.id}
          type="button"
          aria-label={`Timeline window · ${w.id}`}
          aria-pressed={windowId === w.id}
          className={`px-2.5 py-1 text-xs transition-colors ${
            windowId === w.id ? 'bg-signal/10 text-ink' : 'text-dim hover:text-ink'
          } ${i < WINDOWS.length - 1 ? 'border-r border-hair' : ''}`}
          onClick={() => setWindowId(w.id)}
        >
          {w.id}
        </button>
      ))}
    </div>
  )

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
            sub={`${snap.footprint.starts} starts · ${snap.footprint.exits} exits${
              snap.footprint.orphanCount > 0 ? ` · ${snap.footprint.orphanCount} orphaned` : ''
            }`}
          />
        </div>
      </SettingsSection>

      {(snap.objects.length > 0 || ended.length > 0) && (
        <SettingsSection
          title="Argus objects"
          subtitle={
            'Every process attributed to the driver, connector, or window that owns it. ' +
            'The live rows account for the footprint above (displayed values are ' +
            'independently rounded, so they may not add up exactly).' +
            // Only claimed when there is a divider and ended rows beneath it to describe —
            // in the normal case there is neither, and the unconditional sentence would be
            // an assertion about a divider the page never draws.
            (ended.length > 0
              ? ' Rows below the divider have already exited and are shown for their history only.'
              : '')
          }
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-mute">
                <th className="px-3 py-1">Object</th>
                <th className="px-3 py-1">CPU · {windowLabel}</th>
                <th className="px-3 py-1 text-right">CPU</th>
                <th className="px-3 py-1 text-right">Memory</th>
                <th className="px-3 py-1 text-right">Uptime</th>
                <th className="px-3 py-1 text-right">Procs</th>
              </tr>
            </thead>
            <tbody>
              {snap.objects.map((o) => (
                <ObjectRow
                  key={o.id}
                  o={o}
                  series={seriesById.get(o.id)?.cpuPercent ?? null}
                  max={sparkMax}
                  bridge={sparkBridge}
                />
              ))}
              {ended.length > 0 && (
                <tr className="border-t border-hair">
                  <td colSpan={6} className="px-3 py-1 text-xs uppercase tracking-wide text-mute">
                    Ended in the last {windowLabel}
                    {endedOverflow > 0 ? ` · ${endedOverflow} more not shown` : ''}
                  </td>
                </tr>
              )}
              {ended.map((s) => (
                <EndedObjectRow key={s.id} s={s} max={sparkMax} bridge={sparkBridge} />
              ))}
            </tbody>
          </table>
        </SettingsSection>
      )}

      {history && (
        <SettingsSection
          title="Timeline"
          subtitle="Totals over time, sampled every 5 seconds. Gaps are stretches with no sample — the sidecar was down, or the machine was asleep."
          action={windowSelector}
        >
          <TimelineChart
            testId="diag-timeline-cpu"
            title="CPU · peak per 5s"
            series={history.total.cpuPercent}
            kind="percent"
            accent="--signal"
            bridge={bridgeBuckets(history.bucketMs)}
            from={history.from}
            bucketMs={history.bucketMs}
            format={(v) => `${formatPercent(v)}%`}
          />
          <TimelineChart
            testId="diag-timeline-rss"
            title="Memory · mean per 5s"
            series={history.total.rssBytes}
            kind="bytes"
            accent="--review"
            bridge={bridgeBuckets(history.bucketMs)}
            from={history.from}
            bucketMs={history.bucketMs}
            format={formatBytes}
          />
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
