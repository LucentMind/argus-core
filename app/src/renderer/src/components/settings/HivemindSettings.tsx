import { Fragment, useEffect, useState } from 'react'
import { SettingsSection, SettingRow, DraftInput, FIELD } from './settingsLayout'
import { Btn, Chip } from '../ui'
import { settingsStore } from '../../lib/settingsStore'
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
  onCancel
}: {
  it: HivemindItem
  busy: boolean
  confirm: UpdateConfirm | null
  onInstall: () => void
  onOpenUpdate: () => void
  onReinstall: () => void
  onCancel: () => void
}): React.JSX.Element {
  const open = confirm !== null && confirm.kind === it.kind && confirm.name === it.name
  return (
    <Fragment>
      <SettingRow
        label={it.name}
        description={it.description || undefined}
        badge={it.updateAvailable ? <Chip tone="review">update available</Chip> : undefined}
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
      </SettingRow>
      {open && confirm && (
        <div className="flex flex-col gap-2 px-4 py-3">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-dim">
            {confirm.diff || '(no content diff — metadata only)'}
          </pre>
          <div className="flex items-center gap-2">
            <Btn
              variant="primary"
              aria-label={`Re-install ${it.name}`}
              disabled={busy}
              onClick={onReinstall}
            >
              Re-install
            </Btn>
            <Btn variant="ghost" onClick={onCancel}>
              Cancel
            </Btn>
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
    return () => {
      mounted = false
    }
  }, [])

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

  const g = settingsPayload.settings.hivemind
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

      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-ink">{payload.repo}</span>
        {payload.headCommit && <Chip tone="neutral">@ {payload.headCommit.slice(0, 7)}</Chip>}
        {payload.lastSynced && (
          <span className="text-xs text-mute">
            synced {new Date(payload.lastSynced).toLocaleString()}
          </span>
        )}
        <Btn
          variant="outline"
          className="ml-auto"
          disabled={busy}
          onClick={() => void run(() => window.argus.hivemind.sync())}
        >
          {busy ? 'Syncing…' : 'Sync'}
        </Btn>
      </div>

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
                    <Btn
                      variant="outline"
                      aria-label={`Push ${it.name}`}
                      disabled={busy}
                      onClick={() => void openPush(it)}
                    >
                      Push…
                    </Btn>
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
                          <Btn variant="ghost" onClick={() => setPushConfirm(null)}>
                            Cancel
                          </Btn>
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
