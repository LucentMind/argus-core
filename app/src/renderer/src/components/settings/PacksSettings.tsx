import { useCallback, useEffect, useState } from 'react'
import semver from 'semver'
import { SettingsSection, SettingRow, DisclosureBtn } from './settingsLayout'
import { Btn, Chip } from '../ui'
import { ToolRow, useToolProbes } from './ToolRow'
import type { PacksListPayload, InstalledPackRow } from '../../../../shared/packs'
import type { SettingsPayload } from '../../../../shared/settings'

function installErrorMessage(code: string, error: string): string {
  switch (code) {
    case 'checksum':
      return `Bundle failed verification (corrupt or tampered): ${error}`
    case 'platform':
    case 'api':
      return error
    case 'manifest':
      return `Not a valid pack bundle: ${error}`
    default:
      return `Install failed: ${error}`
  }
}

/**
 * One installed pack: its header row, plus its tools behind a collapsed-by-default
 * disclosure. Packs each contribute their own tool rows (path input + probe + Browse), so
 * with several installed the always-open list buried the pack names it belonged to — the
 * pack list is the index, the tools are the detail. The chevron lives on the pack row
 * itself (same idiom as a provider row) rather than on a separate summary line.
 * Local state per pack — expansion is a transient view concern, not a setting.
 */
function PackCard({
  pack,
  tools,
  report,
  busy,
  onUninstall,
  onInstalled
}: {
  pack: InstalledPackRow
  tools: SettingsPayload['resolvedTools']
  report: ReturnType<typeof useToolProbes>['report']
  busy: boolean
  onUninstall: () => void
  onInstalled: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <SettingRow
        label={pack.displayName}
        description={`${pack.id}${pack.platform ? ` · ${pack.platform}` : ''}`}
        badge={
          <span className="flex items-center gap-1">
            <Chip tone="neutral">{pack.installedVersion ?? pack.loadedVersion ?? '—'}</Chip>
            {pack.pendingRelaunch && <Chip tone="review">pending relaunch</Chip>}
            {pack.binaries.map((b) => (
              <Chip key={b.id} tone={b.ok ? 'signal' : 'danger'} title={b.detail}>
                {b.id}
              </Chip>
            ))}
          </span>
        }
      >
        {pack.installedVersion != null && (
          <Btn
            variant="danger"
            aria-label={`Uninstall · ${pack.id}`}
            disabled={busy}
            onClick={onUninstall}
          >
            Uninstall
          </Btn>
        )}
        {tools.length > 0 && (
          <DisclosureBtn
            expanded={open}
            onToggle={() => setOpen((o) => !o)}
            label={`tools · ${pack.id}`}
          />
        )}
      </SettingRow>
      {open && tools.length > 0 && (
        <div data-pack-tools={pack.id} className="border-l border-hair pl-4">
          {tools.map((t) => (
            <ToolRow key={t.id} row={t} report={report} onInstalled={onInstalled} />
          ))}
        </div>
      )}
    </div>
  )
}

export function PacksSettings({ settings }: { settings: SettingsPayload }): React.JSX.Element {
  const { report, running, runChecks } = useToolProbes()
  const [payload, setPayload] = useState<PacksListPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [needsRelaunch, setNeedsRelaunch] = useState(false)

  const refresh = useCallback(async () => {
    setPayload(await window.argus.packs.list())
  }, [])

  useEffect(() => {
    let mounted = true
    void (async () => {
      const data = await window.argus.packs.list()
      if (mounted) setPayload(data)
    })()
    const off = window.argus.packs.onChanged(() => void refresh())
    return () => {
      mounted = false
      off()
    }
  }, [refresh])

  async function install(): Promise<void> {
    if (busy) return
    setError(null)
    const source = await window.argus.packs.pickBundle()
    if (!source) return
    setBusy(true)
    try {
      const info = await window.argus.packs.inspect(source)
      if (!info.platformCompatible) {
        setError(
          `This bundle targets ${info.platform ?? 'an unknown platform'}, which does not match this machine.`
        )
        return
      }
      if (!info.apiCompatible) {
        setError(`"${info.id}" ${info.version} isn't compatible with this version of Argus.`)
        return
      }
      const current = payload?.packs.find((p) => p.id === info.id)?.installedVersion ?? null
      const bothSemver =
        current != null && semver.valid(info.version) != null && semver.valid(current) != null
      const notNewer = current != null && (bothSemver ? semver.lte(info.version, current) : true)
      if (
        notNewer &&
        !window.confirm(
          `"${info.id}" ${info.version} is not newer than the installed version (${current}). Install anyway?`
        )
      ) {
        return
      }
      const res = await window.argus.packs.install(source)
      if (!res.ok) {
        setError(installErrorMessage(res.code, res.error))
        return
      }
      setNeedsRelaunch(true)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function uninstall(row: InstalledPackRow): Promise<void> {
    if (busy) return
    if (!window.confirm(`Uninstall "${row.id}"? Its binaries, skills, and references are removed.`))
      return
    setError(null)
    setBusy(true)
    try {
      const res = await window.argus.packs.uninstall(row.id)
      if (!res.ok) {
        setError(res.error ?? 'uninstall failed')
        return
      }
      setNeedsRelaunch(true)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!payload) return <div className="text-dim">loading…</div>

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="rounded-r2 border border-danger/30 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}
      {payload.error && (
        <div
          role="alert"
          className="rounded-r2 border border-danger/30 px-3 py-2 text-xs text-danger"
        >
          {payload.error}
        </div>
      )}
      {needsRelaunch && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-r2 border border-hair bg-overlay px-3 py-2 text-xs text-ink"
        >
          <span>Relaunch Argus to apply pack changes.</span>
          <Btn
            variant="primary"
            aria-label="Relaunch now"
            disabled={busy}
            onClick={() => void window.argus.packs.relaunch()}
          >
            Relaunch now
          </Btn>
        </div>
      )}
      <SettingsSection title="Installed Packs">
        {payload.packs.length === 0 && (
          <div className="px-3 py-2 text-xs text-dim">No packs installed.</div>
        )}
        {payload.packs.map((p) => (
          <PackCard
            key={p.id}
            pack={p}
            tools={settings.resolvedTools.filter((t) => t.packId === p.id)}
            report={report}
            busy={busy}
            onUninstall={() => void uninstall(p)}
            onInstalled={runChecks}
          />
        ))}
      </SettingsSection>
      <div className="flex items-center gap-2">
        <Btn
          variant="primary"
          aria-label="Install from file"
          disabled={busy}
          onClick={() => void install()}
        >
          Install from file…
        </Btn>
        <Btn disabled={running} onClick={runChecks}>
          {running ? 'Checking…' : 'Re-run checks'}
        </Btn>
      </div>
    </div>
  )
}
