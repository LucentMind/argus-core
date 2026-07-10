import { useEffect, useState } from 'react'
import { SettingsSection, SettingRow } from './settingsLayout'
import { Btn, Chip } from '../ui'
import type { HivemindPayload, PushableItem } from '../../../../shared/hivemind'
import type { SourceControlStatus } from '../../../../shared/sourcecontrol'

type Confirm =
  | { mode: 'update'; kind: 'skill' | 'reference'; name: string; diff: string }
  | { mode: 'push'; item: PushableItem; preview: string; title: string }

export function HivemindTab(): React.JSX.Element {
  const [payload, setPayload] = useState<HivemindPayload | null>(null)
  const [gh, setGh] = useState<SourceControlStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [prUrl, setPrUrl] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void window.argus.hivemind.get().then((p) => mounted && setPayload(p))
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
    const diff = await window.argus.hivemind.diff(kind, name)
    setConfirm({ mode: 'update', kind, name, diff })
  }

  async function openPush(item: PushableItem): Promise<void> {
    setPrUrl(null)
    const preview = await window.argus.hivemind.pushPreview(item.kind, item.name)
    setConfirm({ mode: 'push', item, preview, title: `Add ${item.name}` })
  }

  async function doPush(): Promise<void> {
    if (!confirm || confirm.mode !== 'push' || busy) return
    setBusy(true)
    setError(null)
    const r = await window.argus.hivemind.push(confirm.item.kind, confirm.item.name, confirm.title)
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setConfirm(null)
    setPrUrl(r.prUrl)
  }

  if (!payload) return <div className="text-dim">loading…</div>

  if (payload.state === 'dormant') {
    return (
      <div className="px-1 py-2 text-sm text-dim">
        Set a HiveMind repo (Settings → General) to enable skill &amp; reference sharing.
      </div>
    )
  }

  const ghProblem = gh && (!gh.installed || !gh.authenticated)

  return (
    <div className="flex flex-col gap-4">
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

      {payload.items.length > 0 && (
        <SettingsSection title="Browse">
          {payload.items.map((it) => (
            <SettingRow
              key={`${it.kind}/${it.name}`}
              label={it.name}
              description={it.description || undefined}
              badge={
                <>
                  <Chip tone="neutral">{it.kind}</Chip>
                  {it.updateAvailable && <Chip tone="review">update available</Chip>}
                </>
              }
            >
              {it.updateAvailable ? (
                <Btn
                  variant="outline"
                  aria-label={`Update ${it.name}`}
                  onClick={() => void openUpdate(it.kind, it.name)}
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
                  onClick={() => void run(() => window.argus.hivemind.install(it.kind, it.name))}
                >
                  Install
                </Btn>
              )}
            </SettingRow>
          ))}
        </SettingsSection>
      )}

      {payload.pushable.length > 0 && (
        <SettingsSection title="Share to HiveMind">
          {payload.pushable.map((it) => (
            <SettingRow
              key={`${it.kind}/${it.name}`}
              label={it.name}
              badge={<Chip tone="neutral">{it.kind}</Chip>}
            >
              <Btn
                variant="outline"
                aria-label={`Push ${it.name}`}
                disabled={busy}
                onClick={() => void openPush(it)}
              >
                Push…
              </Btn>
            </SettingRow>
          ))}
        </SettingsSection>
      )}

      {prUrl && (
        <div className="flex items-center gap-2 text-sm">
          <Chip tone="signal">PR opened</Chip>
          <Btn variant="ghost" onClick={() => void window.argus.openExternal(prUrl)}>
            {prUrl}
          </Btn>
        </div>
      )}

      {confirm?.mode === 'update' && (
        <SettingsSection title={`Update ${confirm.name}`}>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs text-dim">
            {confirm.diff || '(no content diff — metadata only)'}
          </pre>
          <div className="flex items-center gap-2 px-4 py-3">
            <Btn
              variant="primary"
              aria-label={`Re-install ${confirm.name}`}
              disabled={busy}
              onClick={() => {
                const c = confirm
                setConfirm(null)
                void run(() => window.argus.hivemind.install(c.kind, c.name))
              }}
            >
              Re-install
            </Btn>
            <Btn variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Btn>
          </div>
        </SettingsSection>
      )}

      {confirm?.mode === 'push' && (
        <SettingsSection title={`Push ${confirm.item.name} to ${payload.repo}`}>
          <div className="flex items-center gap-2 px-4 pt-3">
            <span className="text-xs text-dim">PR title</span>
            <input
              aria-label="PR title"
              className="h-7 min-w-0 flex-1 rounded-r2 border border-hair bg-overlay px-2 text-xs text-ink"
              value={confirm.title}
              onChange={(e) => setConfirm({ ...confirm, title: e.target.value })}
            />
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs text-dim">
            {confirm.preview}
          </pre>
          <div className="flex items-center gap-2 px-4 py-3">
            <Btn
              variant="primary"
              disabled={busy || !confirm.title.trim()}
              onClick={() => void doPush()}
            >
              {busy ? 'Pushing…' : 'Open pull request'}
            </Btn>
            <Btn variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Btn>
          </div>
        </SettingsSection>
      )}
    </div>
  )
}
