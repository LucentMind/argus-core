import { useEffect, useState } from 'react'
import { settingsStore } from '../../lib/settingsStore'
import { Btn, Chip } from '../ui'
import { SettingsSection, SettingRow, FIELD, DraftInput } from './settingsLayout'
import type { ProbeToolsReport, SettingsPayload } from '../../../../shared/settings'

export function ToolsSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const t = payload.settings.tools
  const rt = payload.resolvedTools
  const [report, setReport] = useState<ProbeToolsReport | null>(null)
  const [running, setRunning] = useState(false)

  function runChecks(): void {
    setReport(null)
    setRunning(true)
    void window.argus.settings.probeTools().then((r: ProbeToolsReport) => {
      setReport(r)
      setRunning(false)
    })
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only probe with controlled setState
    runChecks()
  }, [])

  async function browse(key: 'parseBin' | 'traceDir', mode: 'file' | 'directory'): Promise<void> {
    const p = await window.argus.settings.pickPath(mode)
    if (p) void settingsStore.patch({ tools: { [key]: p } })
  }

  return (
    <SettingsSection title="Analysis tools">
      <SettingRow
        label="sample-parse binary"
        description="Rust BINLOG decoder (overridable via environment variable)"
        badge={
          rt.parseBin.source === 'env' ? (
            <Chip tone="neutral">env: ARGUS_PARSE_BIN</Chip>
          ) : undefined
        }
        isDefault={t.parseBin === ''}
        onReset={() => void settingsStore.patch({ tools: { parseBin: null } })}
      >
        {report ? (
          report.parseBin.path ? (
            <Chip tone="review">
              {report.parseBin.version ? `found · ${report.parseBin.version}` : 'found'}
            </Chip>
          ) : (
            <Chip tone="danger">not found</Chip>
          )
        ) : (
          <Chip>checking…</Chip>
        )}
        <DraftInput
          aria-label="sample-parse path"
          className={`${FIELD} w-64 font-mono`}
          placeholder="auto-resolve"
          value={t.parseBin}
          onCommit={(v) => void settingsStore.patch({ tools: { parseBin: v || null } })}
        />
        <Btn onClick={() => void browse('parseBin', 'file')}>Browse</Btn>
      </SettingRow>
      <SettingRow
        label="Trace tools directory"
        description="Directory containing sample-trace (overridable via environment variable)"
        badge={
          rt.traceDir.source === 'env' ? (
            <Chip tone="neutral">env: ARGUS_TRACE_DIR</Chip>
          ) : undefined
        }
        isDefault={t.traceDir === ''}
        onReset={() => void settingsStore.patch({ tools: { traceDir: null } })}
      >
        {report ? (
          report.traceDir.found ? (
            <Chip tone="review">found</Chip>
          ) : (
            <Chip tone="danger">not found</Chip>
          )
        ) : (
          <Chip>checking…</Chip>
        )}
        <DraftInput
          aria-label="trace tools directory"
          className={`${FIELD} w-64 font-mono`}
          placeholder="auto-resolve"
          value={t.traceDir}
          onCommit={(v) => void settingsStore.patch({ tools: { traceDir: v || null } })}
        />
        <Btn onClick={() => void browse('traceDir', 'directory')}>Browse</Btn>
      </SettingRow>
      <div className="flex justify-end px-4 py-3">
        <Btn disabled={running} onClick={runChecks}>
          {running ? 'Checking…' : 'Re-run checks'}
        </Btn>
      </div>
    </SettingsSection>
  )
}
