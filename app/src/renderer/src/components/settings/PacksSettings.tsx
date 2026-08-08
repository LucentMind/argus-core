import { useCallback, useEffect, useState } from 'react'
import semver from 'semver'
import { SettingsSection, SettingRow, DisclosureBtn } from './settingsLayout'
import { Btn, Chip } from '../ui'
import { confirm } from '../../lib/confirmStore'
import { ToolRow, useToolProbes } from './ToolRow'
import type { PacksListPayload, InstalledPackRow, RepoPackRow } from '../../../../shared/packs'
import type { SettingsPayload } from '../../../../shared/settings'
import { describeUpdate } from '../../../../shared/updates'

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
  onInstalled,
  onUpdate
}: {
  pack: InstalledPackRow
  tools: SettingsPayload['resolvedTools']
  report: ReturnType<typeof useToolProbes>['report']
  busy: boolean
  onUninstall: () => void
  onInstalled: () => void
  onUpdate: () => void
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
            {pack.update?.phase === 'available' && <Chip tone="signal">update available</Chip>}
            {pack.binaries.map((b) => (
              <Chip key={b.id} tone={b.ok ? 'signal' : 'danger'} title={b.detail}>
                {b.id}
              </Chip>
            ))}
          </span>
        }
      >
        {pack.update?.phase === 'available' && (
          <Btn aria-label={`Update · ${pack.id}`} disabled={busy} onClick={onUpdate}>
            Update to {pack.update.version}
          </Btn>
        )}
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
      {pack.update != null && (
        <div className="pl-4 text-sm text-dim">
          {describeUpdate(pack.update, 'pack')}
          {pack.update.phase === 'error' && pack.update.code === 'origin-pin' && (
            <> — download it manually from your vendor and install it with Install from file.</>
          )}
          {pack.update?.phase === 'error' && pack.update.code === 'gh' && (
            <>
              {' '}
              — check your GitHub CLI sign-in under Settings → Health, and that the repository still
              exists and is visible to your account.
            </>
          )}
        </div>
      )}
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
  const [repoOpen, setRepoOpen] = useState(false)
  const [repoRef, setRepoRef] = useState('')
  const [repoResult, setRepoResult] = useState<{ ref: string; packs: RepoPackRow[] } | null>(null)
  // Starts true rather than being flipped on inside the effect below: the check fires on mount
  // unconditionally, so `true` is the accurate initial value and the effect has no synchronous
  // setState in it.
  const [autoChecking, setAutoChecking] = useState(true)

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

  /**
   * Checks for pack updates on entering the page (user-directed, 2026-08-08).
   *
   * The check used to be a button at the bottom of the page, which meant "update available" only
   * ever appeared for a user who already suspected there was one. Opening Sources is exactly the
   * moment the answer is wanted, so the page asks for it itself and the badges are simply there.
   *
   * Separate from `busy`: this fires without the user asking, and gating every install/uninstall
   * control on a background network call the user did not start would make the page briefly
   * unusable on arrival. `autoChecking` only drives the section header's own spinner.
   *
   * Errors are swallowed on purpose. A vendor feed being unreachable is not something the user
   * did, and the per-pack rows already report their own update-check failures
   * (`describeUpdate(pack.update)`) — the page-level red alert belongs to actions, not to this.
   */
  useEffect(() => {
    let mounted = true
    void window.argus.packs
      .checkUpdates()
      .then(() => (mounted ? refresh() : undefined))
      .catch((e) => console.warn('[packs] update check failed', e))
      .finally(() => {
        if (mounted) setAutoChecking(false)
      })
    return () => {
      mounted = false
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
        !(await confirm({
          title: `Install "${info.id}" ${info.version} anyway?`,
          message: `It is not newer than the installed version (${current}).`,
          confirmLabel: 'Install'
        }))
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
    if (
      !(await confirm({
        title: `Uninstall "${row.id}"?`,
        message: 'Its binaries, skills, and references are removed.',
        confirmLabel: 'Uninstall',
        danger: true
      }))
    )
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

  async function applyUpdate(id: string): Promise<void> {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const status = await window.argus.packs.applyUpdate(id)
      if (status.phase === 'ready') {
        setNeedsRelaunch(true)
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function checkUpdates(): Promise<void> {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      await window.argus.packs.checkUpdates()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function findRepoPacks(): Promise<void> {
    if (busy) return
    setError(null)
    setRepoResult(null)
    setBusy(true)
    try {
      const ref = repoRef.trim()
      const res = await window.argus.packs.inspectRepo(ref)
      if (!res.ok) {
        setError(res.error)
        return
      }
      if (res.packs.length === 0) {
        setError('That repository publishes no Argus packs in its latest release.')
        return
      }
      setRepoResult({ ref, packs: res.packs })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function installFromRepo(packId: string): Promise<void> {
    if (busy || !repoResult) return
    setError(null)
    setBusy(true)
    try {
      const res = await window.argus.packs.installFromRepo(repoResult.ref, packId)
      if (!res.ok) {
        setError(installErrorMessage(res.code, res.error))
        return
      }
      setNeedsRelaunch(true)
      setRepoOpen(false)
      setRepoResult(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!payload) return <div className="text-dim">loading…</div>

  // Two sources, and neither is sufficient alone. `payload.relaunchRequired` is the durable one —
  // it survives leaving this page, a second window, and a renderer reload, and it is the half that
  // was missing. `needsRelaunch` is the local echo of an install result we already hold, and it
  // keeps the prompt immediate instead of making it wait on the `list()` round trip that follows.
  const relaunchNeeded = needsRelaunch || payload.relaunchRequired

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
      {relaunchNeeded && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-r2 border border-hair bg-overlay px-3 py-2 text-xs text-ink"
        >
          <span>Relaunch Argus to apply pack changes.</span>
          {/* Never gated on `busy`. That flag is this component's own in-flight marker for pack
              operations, so any operation that fails to settle strands the one control that fixes
              a stale-pack state — and it says nothing about work started from another window
              anyway. Relaunching is always a legal thing to ask for. */}
          <Btn
            variant="primary"
            aria-label="Relaunch now"
            onClick={() => void window.argus.packs.relaunch()}
          >
            Relaunch now
          </Btn>
        </div>
      )}
      {/* The update check belongs to this section, not to the install-actions row at the bottom of
          the page: it acts on what is listed here, and it is the only control in that row that
          does. Its "update available" badges land on these rows. */}
      <SettingsSection
        title="Installed Packs"
        action={
          <Btn
            aria-label="Check for pack updates"
            disabled={busy || autoChecking}
            onClick={() => void checkUpdates()}
          >
            {autoChecking ? 'Checking…' : 'Check for updates'}
          </Btn>
        }
      >
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
            onUpdate={() => void applyUpdate(p.id)}
          />
        ))}
      </SettingsSection>
      {repoOpen && (
        <div className="flex flex-col gap-2 rounded border border-hair p-3">
          <div className="flex items-center gap-2">
            <input
              aria-label="GitHub repository"
              className="flex-1 rounded border border-hair bg-transparent px-2 py-1 text-xs"
              placeholder="owner/repo"
              value={repoRef}
              disabled={busy}
              onChange={(e) => {
                setRepoRef(e.target.value)
                setRepoResult(null)
              }}
            />
            <Btn disabled={busy || repoRef.trim() === ''} onClick={() => void findRepoPacks()}>
              Find packs
            </Btn>
          </div>
          {repoResult?.packs.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1">
                {p.id} <Chip tone="neutral">{p.version}</Chip>
                {p.reason && <span className="text-dim"> — {p.reason}</span>}
              </span>
              <Btn
                aria-label={`Install ${p.id}`}
                disabled={busy || !p.installable}
                onClick={() => void installFromRepo(p.id)}
              >
                Install
              </Btn>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Btn
          variant="primary"
          aria-label="Install from file"
          disabled={busy}
          onClick={() => void install()}
        >
          Install from file…
        </Btn>
        <Btn
          aria-label="Install from GitHub"
          disabled={busy}
          onClick={() => setRepoOpen((v) => !v)}
        >
          Install from GitHub…
        </Btn>
        <Btn disabled={running} onClick={runChecks}>
          {running ? 'Checking…' : 'Re-run checks'}
        </Btn>
      </div>
    </div>
  )
}
