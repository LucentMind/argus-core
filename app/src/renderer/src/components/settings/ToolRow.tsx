import { useEffect, useState } from 'react'
import { settingsStore } from '../../lib/settingsStore'
import { Btn, Chip } from '../ui'
import { SettingRow, FIELD, DraftInput } from './settingsLayout'
import type { ProbeToolRow, ResolvedToolRow } from '../../../../shared/settings'

/** Bundled tools with a wired one-click installer, keyed by resolved-tool id. */
const AUTO_INSTALLABLE: Record<string, () => Promise<{ ok: boolean; log: string }>> = {
  graphify: () => window.argus.graph.install()
}

/**
 * One probe cycle for every tool on the page — probeTools() returns all rows in a
 * single IPC call, so the page owns the report and hands it to each ToolRow.
 */
// eslint-disable-next-line react-refresh/only-export-components -- hook co-located with the ToolRow component it drives; see MetricCards.tsx for the same pattern
export function useToolProbes(): {
  report: ProbeToolRow[] | null
  running: boolean
  runChecks: () => void
} {
  const [report, setReport] = useState<ProbeToolRow[] | null>(null)
  const [running, setRunning] = useState(false)

  function runChecks(): void {
    setReport(null)
    setRunning(true)
    void window.argus.settings.probeTools().then((r: ProbeToolRow[]) => {
      setReport(r)
      setRunning(false)
    })
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only probe with controlled setState
    runChecks()
  }, [])

  return { report, running, runChecks }
}

export function ToolRow({
  row,
  report,
  onInstalled
}: {
  row: ResolvedToolRow
  report: ProbeToolRow[] | null
  onInstalled: () => void
}): React.JSX.Element {
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState('')

  const probe = report?.find((r) => r.id === row.id)
  const canAutoInstall = row.id in AUTO_INSTALLABLE && report != null && !probe?.ok

  async function browse(key: string, mode: 'file' | 'directory'): Promise<void> {
    const p = await window.argus.settings.pickPath(mode)
    if (p) void settingsStore.patch({ tools: { [key]: p } })
  }

  async function install(): Promise<void> {
    const installer = AUTO_INSTALLABLE[row.id]
    if (!installer) return
    setInstalling(true)
    setInstallLog('')
    try {
      const r = await installer()
      setInstallLog(r.log)
      if (r.ok) onInstalled()
    } finally {
      setInstalling(false)
    }
  }

  return (
    <SettingRow
      label={row.displayName}
      description={row.description}
      badge={
        row.source === 'env' && row.envVar ? (
          <Chip tone="neutral">env: {row.envVar}</Chip>
        ) : undefined
      }
      isDefault={row.settingsValue === ''}
      onReset={
        row.settingsKey
          ? () => void settingsStore.patch({ tools: { [row.settingsKey as string]: null } })
          : undefined
      }
      stacked
      trailing={
        report ? (
          probe?.ok ? (
            <Chip tone="review">{probe.chip}</Chip>
          ) : (
            <Chip tone="danger">not found</Chip>
          )
        ) : (
          <Chip>checking…</Chip>
        )
      }
    >
      {row.settingsKey && (
        <>
          <DraftInput
            aria-label={`${row.displayName} path`}
            className={`${FIELD} flex-1 min-w-40 font-mono`}
            placeholder="auto-resolve"
            value={row.settingsValue}
            onCommit={(v) =>
              void settingsStore.patch({ tools: { [row.settingsKey as string]: v || null } })
            }
          />
          <Btn
            onClick={() =>
              void browse(row.settingsKey as string, row.kind === 'exe' ? 'file' : 'directory')
            }
          >
            Browse
          </Btn>
        </>
      )}
      {canAutoInstall && (
        <Btn variant="primary" disabled={installing} onClick={() => void install()}>
          {installing ? 'Installing…' : 'Install'}
        </Btn>
      )}
      {installLog && <div className="text-mute w-full break-all text-xs">{installLog}</div>}
    </SettingRow>
  )
}
