import { Fragment, useEffect, useState } from 'react'
import { BookUp, ExternalLink, RefreshCw, X } from 'lucide-react'
import { SettingsSection, SettingRow, DraftInput, FIELD } from './settingsLayout'
import { Btn, Chip, IconBtn } from '../ui'
import { TierBadge } from './TierBadge'
import { settingsStore } from '../../lib/settingsStore'
import { confirm as askConfirm } from '../../lib/confirmStore'
import { UnifiedDiffView } from '../UnifiedDiffView'
import type { HivemindItem, HivemindPayload, PushableItem } from '../../../../shared/hivemind'
import type { SettingsPayload } from '../../../../shared/settings'
import type { SourceControlStatus } from '../../../../shared/sourcecontrol'

type UpdateConfirm = { kind: 'skill' | 'reference'; name: string; diff: string }
type PushConfirm = { item: PushableItem; preview: string; title: string }

/** One Browse-tab row plus its inline update-diff panel, expanded directly beneath the row when active. */
function BrowseRow({
  it,
  busy,
  confirm,
  onInstall,
  onOpenUpdate,
  onReinstall,
  onCancel,
  onClaim,
  onUninstall
}: {
  it: HivemindItem
  busy: boolean
  confirm: UpdateConfirm | null
  onInstall: () => void
  onOpenUpdate: () => void
  onReinstall: () => void
  onCancel: () => void
  onClaim: () => void
  onUninstall: () => void
}): React.JSX.Element {
  const open = confirm !== null && confirm.kind === it.kind && confirm.name === it.name
  return (
    <Fragment>
      <SettingRow
        label={it.name}
        description={it.description || undefined}
        badge={
          <>
            {it.localTier && <TierBadge tier={it.localTier} />}
            {it.updateAvailable ? <Chip tone="review">update available</Chip> : undefined}
          </>
        }
      >
        {it.updateAvailable ? (
          <Btn
            variant="outline"
            aria-label={`Update ${it.name}`}
            disabled={busy}
            onClick={onOpenUpdate}
          >
            Update
          </Btn>
        ) : it.installed ? (
          <Chip tone="signal">installed</Chip>
        ) : (
          <Btn
            variant="outline"
            aria-label={`Install ${it.name}`}
            disabled={busy}
            onClick={onInstall}
          >
            Install
          </Btn>
        )}
        {(it.kind === 'skill'
          ? it.installed
          : it.localTier === 'hivemind' || it.localTier === 'confluence') && (
          <Btn
            variant="danger"
            aria-label={`Uninstall ${it.name}`}
            disabled={busy}
            onClick={() => {
              void askConfirm({
                title: `Uninstall ${it.name}?`,
                message:
                  it.kind === 'skill'
                    ? 'Its skills-hivemind folder is removed; it stays installable from Browse.'
                    : 'Its local references copy is removed; it stays installable from Browse.',
                confirmLabel: 'Uninstall',
                danger: true
              }).then((ok) => {
                if (ok) onUninstall()
              })
            }}
          >
            Uninstall
          </Btn>
        )}
        {it.kind === 'reference' && it.localTier === 'hivemind' && (
          <Btn
            variant="outline"
            aria-label={`Keep ${it.name} as mine`}
            disabled={busy}
            onClick={() => {
              void askConfirm({
                title: `Keep ${it.name} as yours?`,
                message:
                  'It becomes pushable to the HiveMind and future updates keep your authorship.',
                confirmLabel: 'Keep as mine'
              }).then((ok) => {
                if (ok) onClaim()
              })
            }}
          >
            Keep as mine
          </Btn>
        )}
      </SettingRow>
      {open && confirm && (
        <div className="flex flex-col gap-2 px-4 py-3">
          {confirm.diff ? (
            <UnifiedDiffView diff={confirm.diff} />
          ) : (
            <span className="font-mono text-xs text-dim">(no content diff — metadata only)</span>
          )}
          <div className="flex items-center gap-2">
            <Btn
              variant="primary"
              aria-label={`Re-install ${it.name}`}
              disabled={busy}
              onClick={onReinstall}
            >
              Re-install
            </Btn>
            <IconBtn aria-label="Cancel" title="Cancel" onClick={onCancel}>
              <X size={14} />
            </IconBtn>
          </div>
        </div>
      )}
    </Fragment>
  )
}

const TABS = [
  { id: 'browse', label: 'Browse' },
  { id: 'share', label: 'Share to HiveMind' }
] as const
type HivemindTabId = (typeof TABS)[number]['id']

function matchesFilter(it: { name: string; description: string }, filter: string): boolean {
  if (!filter) return true
  const q = filter.toLowerCase()
  return it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q)
}

export function HivemindSettings({
  payload: settingsPayload
}: {
  payload: SettingsPayload
}): React.JSX.Element {
  const [payload, setPayload] = useState<HivemindPayload | null>(null)
  const [gh, setGh] = useState<SourceControlStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<HivemindTabId>('browse')
  const [filter, setFilter] = useState('')
  const [updateConfirm, setUpdateConfirm] = useState<UpdateConfirm | null>(null)
  const [pushConfirm, setPushConfirm] = useState<PushConfirm | null>(null)
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [check, setCheck] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle')
  const [checkError, setCheckError] = useState<string | null>(null)

  const g = settingsPayload.settings.hivemind

  // Re-runs whenever the repo setting changes so the payload, gh status, and
  // readiness probe all refresh immediately after the user commits a new repo
  // (previously mount-only: the Browse list stayed dormant until re-entering the tab).
  useEffect(() => {
    let mounted = true
    void window.argus.hivemind
      .get()
      .then((p) => {
        if (!mounted) return
        setPayload(p)
        if (p.error) setError(p.error)
      })
      .catch((e) => mounted && setError(e instanceof Error ? e.message : String(e)))
    void window.argus.sourceControl.status().then((s) => mounted && setGh(s))
    if (g.repo.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- repo-keyed probe: set 'checking' immediately for instant feedback before the async check resolves
      setCheck('checking')
      setCheckError(null)
      void window.argus.hivemind.check().then((r) => {
        if (!mounted) return
        setCheck(r.ok ? 'ok' : 'fail')
        if (!r.ok) setCheckError(r.error)
      })
    } else {
      setCheck('idle')
    }
    return () => {
      mounted = false
    }
  }, [g.repo])

  async function run(fn: () => Promise<HivemindPayload>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const p = await fn()
      setPayload(p)
      if (p.error) setError(p.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function openUpdate(kind: 'skill' | 'reference', name: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const diff = await window.argus.hivemind.diff(kind, name)
      setUpdateConfirm({ kind, name, diff })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function openPush(item: PushableItem): Promise<void> {
    if (busy) return
    setPrUrl(null)
    setBusy(true)
    setError(null)
    try {
      const preview = await window.argus.hivemind.pushPreview(item.kind, item.name)
      setPushConfirm({ item, preview, title: `Add ${item.name}` })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doPush(): Promise<void> {
    if (!pushConfirm || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.argus.hivemind.push(
        pushConfirm.item.kind,
        pushConfirm.item.name,
        pushConfirm.title
      )
      if (!r.ok) {
        setError(r.error)
        return
      }
      setPushConfirm(null)
      setPrUrl(r.prUrl)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const statusChip = ((): React.JSX.Element | null => {
    if (check === 'checking') return <Chip tone="neutral">checking…</Chip>
    if (check === 'fail')
      return (
        <Chip tone="danger" title={checkError ?? undefined}>
          not reachable
        </Chip>
      )
    if (payload?.state === 'ready') return <Chip tone="signal">synced</Chip>
    if (payload?.state === 'not-cloned') return <Chip tone="review">ready to sync</Chip>
    if (payload?.state === 'error') return <Chip tone="danger">error</Chip>
    return null
  })()

  const trimmedRepo = g.repo.trim()
  const isGithubSlug = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmedRepo)
  const repoSection = (
    <SettingsSection title="Repository">
      <SettingRow
        label="HiveMind repo"
        description="GitHub org/name of the shared skills & references repo. Blank keeps HiveMind features off."
        isDefault={g.repo === ''}
        onReset={() => void settingsStore.patch({ hivemind: { repo: null } })}
      >
        <DraftInput
          aria-label="HiveMind repo"
          className={`${FIELD} w-56 font-mono`}
          placeholder="org/name"
          value={g.repo}
          onCommit={(v) => void settingsStore.patch({ hivemind: { repo: v.trim() } })}
        />
      </SettingRow>
      {trimmedRepo !== '' && (
        <div className="flex items-center gap-2 px-4 py-3">
          {isGithubSlug ? (
            <button
              aria-label={`Open ${trimmedRepo} on GitHub`}
              title={`Open https://github.com/${trimmedRepo}`}
              className="inline-flex items-center gap-1 font-mono text-sm text-ink transition-colors hover:text-signal"
              onClick={() => void window.argus.openExternal(`https://github.com/${trimmedRepo}`)}
            >
              {trimmedRepo}
              <ExternalLink size={12} aria-hidden="true" />
            </button>
          ) : (
            <span className="font-mono text-sm text-ink">{trimmedRepo}</span>
          )}
          {payload?.headCommit && <Chip tone="neutral">@ {payload.headCommit.slice(0, 7)}</Chip>}
          {statusChip}
          {payload?.lastSynced && (
            <span className="text-xs text-mute">
              synced {new Date(payload.lastSynced).toLocaleString()}
            </span>
          )}
          <IconBtn
            aria-label="Sync"
            title="Sync HiveMind"
            className="ml-auto"
            disabled={busy}
            onClick={() => void run(() => window.argus.hivemind.sync())}
          >
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
          </IconBtn>
        </div>
      )}
    </SettingsSection>
  )

  if (!payload) {
    return (
      <div className="flex flex-col gap-6">
        {repoSection}
        <div className="text-dim">loading…</div>
      </div>
    )
  }

  if (payload.state === 'dormant') {
    return (
      <div className="flex flex-col gap-6">
        {repoSection}
        <div className="px-1 py-2 text-sm text-dim">
          Set a HiveMind repo above to enable skill &amp; reference sharing.
        </div>
      </div>
    )
  }

  const ghProblem = gh && (!gh.installed || !gh.authenticated)
  const filtered = payload.items.filter((it) => matchesFilter(it, filter))
  const skills = filtered.filter((it) => it.kind === 'skill')
  const references = filtered.filter((it) => it.kind === 'reference')

  return (
    <div className="flex flex-col gap-6">
      {repoSection}

      {error && (
        <div
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
        >
          {error}
        </div>
      )}
      {ghProblem && (
        <div className="rounded-r2 border border-review/40 bg-review/10 px-3 py-2 text-xs text-ink">
          GitHub CLI {gh?.installed ? 'is not authenticated' : 'is not installed'} — pushing (and
          private repos) will fail. See Settings → Health.
        </div>
      )}

      {payload.state === 'not-cloned' && (
        <div className="text-sm text-dim">Not cloned yet — Sync to fetch the HiveMind.</div>
      )}

      <div role="tablist" className="flex items-center gap-1 border-b border-hair">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`-mb-px border-b px-3 py-1.5 text-sm transition-colors ${
              tab === t.id ? 'border-signal text-ink' : 'border-transparent text-dim hover:text-ink'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'browse' && (
        <div className="flex flex-col gap-4">
          <input
            aria-label="Filter HiveMind content"
            className={`${FIELD} w-full`}
            placeholder="Filter by name or description…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />

          {filter && skills.length === 0 && references.length === 0 ? (
            <div className="px-1 py-2 text-sm text-dim">
              No HiveMind content matches &quot;{filter}&quot;.
            </div>
          ) : (
            <>
              {skills.length > 0 && (
                <SettingsSection title="Skills">
                  {skills.map((it) => (
                    <BrowseRow
                      key={`${it.kind}/${it.name}`}
                      it={it}
                      busy={busy}
                      confirm={updateConfirm}
                      onInstall={() =>
                        void run(() => window.argus.hivemind.install(it.kind, it.name))
                      }
                      onOpenUpdate={() => void openUpdate(it.kind, it.name)}
                      onReinstall={() => {
                        setUpdateConfirm(null)
                        void run(() => window.argus.hivemind.install(it.kind, it.name))
                      }}
                      onCancel={() => setUpdateConfirm(null)}
                      onClaim={() => void run(() => window.argus.hivemind.claimReference(it.name))}
                      onUninstall={() =>
                        void run(() => window.argus.hivemind.uninstallSkill(it.name))
                      }
                    />
                  ))}
                </SettingsSection>
              )}

              {references.length > 0 && (
                <SettingsSection title="References">
                  {references.map((it) => (
                    <BrowseRow
                      key={`${it.kind}/${it.name}`}
                      it={it}
                      busy={busy}
                      confirm={updateConfirm}
                      onInstall={() =>
                        void run(() => window.argus.hivemind.install(it.kind, it.name))
                      }
                      onOpenUpdate={() => void openUpdate(it.kind, it.name)}
                      onReinstall={() => {
                        setUpdateConfirm(null)
                        void run(() => window.argus.hivemind.install(it.kind, it.name))
                      }}
                      onCancel={() => setUpdateConfirm(null)}
                      onClaim={() => void run(() => window.argus.hivemind.claimReference(it.name))}
                      onUninstall={() =>
                        void run(() => window.argus.hivemind.uninstallReference(it.name))
                      }
                    />
                  ))}
                </SettingsSection>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'share' && (
        <div className="flex flex-col gap-4">
          {prUrl && (
            <div className="flex items-center gap-2 text-sm">
              <Chip tone="signal">PR opened</Chip>
              <Btn variant="ghost" onClick={() => void window.argus.openExternal(prUrl)}>
                {prUrl}
              </Btn>
            </div>
          )}

          {payload.pushable.length > 0 && (
            <SettingsSection title="Share to HiveMind">
              {payload.pushable.map((it) => (
                <Fragment key={`${it.kind}/${it.name}`}>
                  <SettingRow label={it.name} badge={<Chip tone="neutral">{it.kind}</Chip>}>
                    <IconBtn
                      aria-label={`Push ${it.name}`}
                      title="Push to HiveMind…"
                      disabled={busy}
                      onClick={() => void openPush(it)}
                    >
                      <BookUp size={14} />
                    </IconBtn>
                  </SettingRow>
                  {pushConfirm &&
                    pushConfirm.item.kind === it.kind &&
                    pushConfirm.item.name === it.name && (
                      <div className="flex flex-col gap-2 px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-dim">PR title</span>
                          <input
                            aria-label="PR title"
                            className="h-7 min-w-0 flex-1 rounded-r2 border border-hair bg-overlay px-2 text-xs text-ink"
                            value={pushConfirm.title}
                            onChange={(e) =>
                              setPushConfirm({ ...pushConfirm, title: e.target.value })
                            }
                          />
                        </div>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-dim">
                          {pushConfirm.preview}
                        </pre>
                        <div className="flex items-center gap-2">
                          <Btn
                            variant="primary"
                            disabled={busy || !pushConfirm.title.trim()}
                            onClick={() => void doPush()}
                          >
                            {busy ? 'Pushing…' : 'Open pull request'}
                          </Btn>
                          <IconBtn
                            aria-label="Cancel"
                            title="Cancel"
                            onClick={() => setPushConfirm(null)}
                          >
                            <X size={14} />
                          </IconBtn>
                        </div>
                      </div>
                    )}
                </Fragment>
              ))}
            </SettingsSection>
          )}
        </div>
      )}
    </div>
  )
}
