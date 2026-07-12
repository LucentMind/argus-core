import { useCallback, useEffect, useState } from 'react'
import { SettingsSection, SettingRow } from './settingsLayout'
import { Btn, Chip } from '../ui'
import type { PacksListPayload, InstalledPackRow } from '../../../../shared/packs'

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

export function PacksSettings(): React.JSX.Element {
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
      if (
        current &&
        !window.confirm(
          `A version of "${info.id}" is already installed (${current}). Install ${info.version} anyway?`
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
      {needsRelaunch && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-r2 border border-hair bg-overlay px-3 py-2 text-xs text-ink"
        >
          <span>Relaunch Argus to apply pack changes.</span>
          <Btn
            variant="primary"
            aria-label="Relaunch now"
            onClick={() => void window.argus.packs.relaunch()}
          >
            Relaunch now
          </Btn>
        </div>
      )}
      <SettingsSection title="Installed Packs">
        <div className="flex justify-end px-3 pb-1">
          <Btn
            variant="primary"
            aria-label="Install from file"
            disabled={busy}
            onClick={() => void install()}
          >
            Install from file…
          </Btn>
        </div>
        {payload.packs.length === 0 && (
          <div className="px-3 py-2 text-xs text-dim">No packs installed.</div>
        )}
        {payload.packs.map((p) => (
          <SettingRow
            key={p.id}
            label={p.displayName}
            description={`${p.id}${p.platform ? ` · ${p.platform}` : ''}`}
            badge={
              <span className="flex items-center gap-1">
                <Chip tone="neutral">{p.installedVersion ?? p.loadedVersion ?? '—'}</Chip>
                {p.pendingRelaunch && <Chip tone="review">pending relaunch</Chip>}
                {p.binaries.map((b) => (
                  <Chip key={b.id} tone={b.ok ? 'signal' : 'danger'} title={b.detail}>
                    {b.id}
                  </Chip>
                ))}
              </span>
            }
          >
            {p.installedVersion != null && (
              <Btn
                variant="danger"
                aria-label={`Uninstall · ${p.id}`}
                disabled={busy}
                onClick={() => void uninstall(p)}
              >
                Uninstall
              </Btn>
            )}
          </SettingRow>
        ))}
      </SettingsSection>
    </div>
  )
}
