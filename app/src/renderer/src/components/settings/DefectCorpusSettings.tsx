import { useEffect, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { SettingsSection, FIELD, DraftInput, Switch } from './settingsLayout'
import { Btn, Card, Chip, IconBtn } from '../ui'
import { settingsStore } from '../../lib/settingsStore'
import { confirm, alert } from '../../lib/confirmStore'
import { corpusTokenSecret } from '../../../../shared/defectCorpus'
import type {
  CorpusInfo,
  CorpusSyncStatus,
  DefectCorpusSourceCfg
} from '../../../../shared/defectCorpus'
import type { SettingsPayload } from '../../../../shared/settings'

type TestResult = { ok: true; info: CorpusInfo } | { ok: false; error: string }

/** How often the sync-status line re-polls while a sync is `running` (Task 8). Not tied to any
 *  existing poll constant elsewhere — this is the only IPC-backed progress poll in Settings, and
 *  1.5s is fast enough to feel live without hammering the corpus server's admin endpoint. */
const SYNC_POLL_MS = 1500

/**
 * Password input for a source's API token. Mirrors `ObservabilitySettings.tsx`'s `SecretInput`
 * exactly (mandated pattern, task-8-brief) rather than importing it: that component isn't
 * exported, and the codebase's existing second copy (`AnnotatedForm`'s secret field) shows
 * duplicating this small piece is the established convention here, not an oversight to fix.
 * The draft starts empty and clears on commit/Escape so plaintext never lingers in renderer
 * state — only the placeholder signals set/not-set.
 */
function SecretInput({
  placeholder,
  onCommit,
  'aria-label': ariaLabel
}: {
  placeholder: string
  onCommit: (plaintext: string) => void
  'aria-label': string
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    if (draft) onCommit(draft)
    setDraft('')
  }
  return (
    <input
      type="password"
      aria-label={ariaLabel}
      className={FIELD}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') {
          setDraft('')
          e.currentTarget.blur()
        }
      }}
    />
  )
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Guarantees `base` doesn't collide with an existing source id — appending `-2`, `-3`, …
 *  until it's free. Without this, two sources whose names slugify the same (e.g. "Platform
 *  Jira" added twice) would silently overwrite one another on Add: same map key, so the
 *  older entry's baseUrl/enabled/token binding is gone the instant the newer one is patched
 *  in. Applied to the randomUUID fallback too — cheap, and it costs nothing to be defensive
 *  about an 8-hex-char collision. */
function uniqueId(base: string, existing: Record<string, unknown>): string {
  if (!(base in existing)) return base
  let n = 2
  while (`${base}-${n}` in existing) n++
  return `${base}-${n}`
}

/** One configured source: name/baseUrl/enabled editing, token entry, Test, and — once a test
 *  has reported admin capability — Sync now with a live status line. */
function SourceCard({ id, cfg }: { id: string; cfg: DefectCorpusSourceCfg }): React.JSX.Element {
  const label = cfg.name.trim() || id
  const [secretSet, setSecretSet] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [syncStatus, setSyncStatus] = useState<CorpusSyncStatus | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    let mounted = true
    void window.argus.secrets.has(corpusTokenSecret(id)).then((v) => mounted && setSecretSet(v))
    return () => {
      mounted = false
    }
  }, [id])

  // Polls only while a sync is actually in flight — `syncStatus?.state` in the dep array means
  // the effect re-runs (and stops scheduling) the moment a poll observes anything but 'running',
  // so there is nothing left ticking once a sync finishes or errors.
  useEffect(() => {
    if (syncStatus?.state !== 'running') return
    let mounted = true
    const t = setInterval(() => {
      void window.argus.defects.syncStatus(id).then((s) => {
        if (mounted) setSyncStatus(s)
      })
    }, SYNC_POLL_MS)
    return () => {
      mounted = false
      clearInterval(t)
    }
  }, [id, syncStatus?.state])

  function patch(p: Partial<DefectCorpusSourceCfg>): void {
    void settingsStore.patch({ defectCorpus: { sources: { [id]: p } } })
  }

  function commitSecret(plaintext: string): void {
    void window.argus.secrets
      .set(corpusTokenSecret(id), plaintext)
      .then(() => setSecretSet(true))
      .catch((err: Error) => void alert(`token not saved: ${err.message}`))
  }

  function runTest(): void {
    if (testing) return
    setTesting(true)
    setTestResult(null)
    void window.argus.defects
      .test(id)
      .then((r) => {
        setTestResult(r)
        if (r.ok && r.info.capabilities.admin) {
          void window.argus.defects.syncStatus(id).then(setSyncStatus)
        }
      })
      // A rejected IPC call (e.g. the main process throws before it can shape an
      // {ok:false} envelope) must still land in the same inline-error path as a
      // reported failure — otherwise it renders nothing and only an unhandled
      // rejection shows up in the console.
      .catch((err: unknown) => {
        setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => setTesting(false))
  }

  function syncNow(): void {
    if (syncing) return
    setSyncing(true)
    void window.argus.defects
      .syncNow(id)
      .then(() => window.argus.defects.syncStatus(id))
      .then(setSyncStatus)
      .finally(() => setSyncing(false))
  }

  function remove(): void {
    void confirm({
      title: `Remove ${label}?`,
      message: 'Its stored API token and any local sync progress are removed too.',
      confirmLabel: 'Remove',
      danger: true
    }).then((ok) => {
      if (!ok) return
      // The confirm copy promises the token goes too — make that true. Fire-and-forget
      // rather than awaited-before-patch: a safeStorage hiccup deleting the token
      // shouldn't block removing the source entry itself, and there is nothing more
      // useful to do with a delete failure here than let it surface in the console the
      // way every other best-effort cleanup in this file already does.
      void window.argus.secrets.delete(corpusTokenSecret(id))
      void settingsStore.patch({ defectCorpus: { sources: { [id]: null } } })
    })
  }

  // Sync now is only meaningful once the admin sync endpoint has been proven reachable — gating
  // on the last test result (not e.g. cfg.enabled) is what the brief calls for, and it also
  // means a source that has never been tested never shows a button that would just 403.
  const canSync = testResult?.ok === true && testResult.info.capabilities.admin

  return (
    <div role="group" aria-label={label}>
      <Card className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-2">
          <DraftInput
            aria-label="Source name"
            className={`${FIELD} min-w-0 flex-1`}
            placeholder="Name"
            value={cfg.name}
            onCommit={(v) => patch({ name: v.trim() })}
          />
          <Switch
            checked={cfg.enabled}
            onChange={(v) => patch({ enabled: v })}
            aria-label={`Enable ${label}`}
          />
          <IconBtn
            aria-label={`Remove ${label}`}
            title="Remove source"
            className="hover:text-danger"
            onClick={remove}
          >
            <Trash2 size={14} />
          </IconBtn>
        </div>
        <DraftInput
          aria-label="Base URL"
          className={`${FIELD} w-full font-mono`}
          placeholder="https://defects.example.com"
          value={cfg.baseUrl}
          onCommit={(v) => patch({ baseUrl: v.trim() })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SecretInput
            aria-label="API token"
            placeholder={secretSet ? '•••• (set)' : 'token'}
            onCommit={commitSecret}
          />
          <Btn variant="outline" disabled={testing} onClick={runTest}>
            {testing ? 'Testing…' : 'Test'}
          </Btn>
          {canSync && (
            <IconBtn
              aria-label={`Sync now · ${label}`}
              title="Sync now"
              disabled={syncing || syncStatus?.state === 'running'}
              onClick={syncNow}
            >
              <RefreshCw
                size={14}
                className={syncStatus?.state === 'running' ? 'animate-spin' : ''}
              />
            </IconBtn>
          )}
        </div>
        {testResult &&
          (testResult.ok ? (
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="neutral">{testResult.info.ticketCount} tickets</Chip>
              <Chip tone="neutral">
                {testResult.info.lastSyncAt
                  ? `synced ${new Date(testResult.info.lastSyncAt).toLocaleString()}`
                  : 'never synced'}
              </Chip>
              {testResult.info.capabilities.semantic && <Chip tone="signal">semantic ✓</Chip>}
              {testResult.info.capabilities.admin && <Chip tone="signal">admin ✓</Chip>}
            </div>
          ) : (
            <div role="alert" className="text-xs text-danger">
              {testResult.error}
            </div>
          ))}
        {canSync && syncStatus && (
          <div className="text-xs text-dim">
            {syncStatus.state === 'running'
              ? `syncing… ${
                  syncStatus.progress
                    ? `${syncStatus.progress.upserted}/${syncStatus.progress.fetched} tickets`
                    : ''
                }`
              : syncStatus.state === 'error'
                ? `sync failed: ${syncStatus.lastError ?? 'unknown error'}`
                : syncStatus.lastSyncAt
                  ? `last synced ${new Date(syncStatus.lastSyncAt).toLocaleString()}`
                  : 'not yet synced'}
          </div>
        )}
      </Card>
    </div>
  )
}

/**
 * Team page section for the defect corpora this workspace searches against (Task 8) — the same
 * "shared upstream" idea as the HiveMind repo and Confluence spaces above it, but for ticket
 * history instead of skills/references. Sources live in `settings.defectCorpus.sources`
 * (Task 1); their API tokens never do — those go through `window.argus.secrets` only, exactly
 * like every other credential in Settings.
 */
export function DefectCorpusSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const sources = payload.settings.defectCorpus.sources
  const entries = Object.entries(sources)
  const [newName, setNewName] = useState('')

  function addSource(): void {
    const name = newName.trim()
    const base = slugify(name) || crypto.randomUUID().slice(0, 8)
    const id = uniqueId(base, sources)
    void settingsStore.patch({
      defectCorpus: {
        sources: { [id]: { name: name || 'New source', baseUrl: '', enabled: true } }
      }
    })
    setNewName('')
  }

  return (
    <SettingsSection
      title="Defect corpus sources"
      subtitle="External defect corpora your team shares — searched for similar past cases and kept in sync from each server."
    >
      {entries.length === 0 && (
        <div className="px-3 py-2 text-xs text-faint">
          No sources yet — add one to enable defect-similarity search.
        </div>
      )}
      {entries.length > 0 && (
        <div className="flex flex-col gap-3 p-3">
          {entries.map(([id, cfg]) => (
            <SourceCard key={id} id={id} cfg={cfg} />
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-3">
        <input
          aria-label="New source name"
          className={`${FIELD} min-w-0 flex-1`}
          placeholder="e.g. platform-jira"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addSource()
          }}
        />
        <Btn variant="outline" onClick={addSource}>
          Add source
        </Btn>
      </div>
    </SettingsSection>
  )
}
