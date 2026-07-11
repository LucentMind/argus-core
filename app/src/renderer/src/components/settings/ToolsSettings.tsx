import { useEffect, useState } from 'react'
import { settingsStore } from '../../lib/settingsStore'
import { Btn, Chip } from '../ui'
import { SettingsSection, SettingRow, FIELD, DraftInput } from './settingsLayout'
import type { ProbeToolRow, SettingsPayload } from '../../../../shared/settings'

export function ToolsSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const rows = payload.resolvedTools
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

  async function browse(key: string, mode: 'file' | 'directory'): Promise<void> {
    const p = await window.argus.settings.pickPath(mode)
    if (p) void settingsStore.patch({ tools: { [key]: p } })
  }

  return (
    <SettingsSection title="Analysis tools">
      {rows.length === 0 && (
        <div className="px-4 py-3 text-sm text-neutral-500">
          No analysis tools declared by installed packs.
        </div>
      )}
      {rows.map((row) => {
        const probe = report?.find((r) => r.id === row.id)
        return (
          <SettingRow
            key={row.id}
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
                    void browse(
                      row.settingsKey as string,
                      row.kind === 'exe' ? 'file' : 'directory'
                    )
                  }
                >
                  Browse
                </Btn>
              </>
            )}
          </SettingRow>
        )
      })}
      <div className="flex justify-end px-4 py-3">
        <Btn disabled={running} onClick={runChecks}>
          {running ? 'Checking…' : 'Re-run checks'}
        </Btn>
      </div>
    </SettingsSection>
  )
}
