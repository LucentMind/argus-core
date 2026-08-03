import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import {
  SettingsSection,
  FIELD,
  TEXTAREA_FIELD,
  DraftInput,
  Switch,
  SelectField
} from './settingsLayout'
import { Btn, Card, Chip, IconBtn } from '../ui'
import { settingsStore } from '../../lib/settingsStore'
import { confirm, alert } from '../../lib/confirmStore'
import { corpusTokenSecret } from '../../../../shared/defectCorpus'
import type {
  CorpusAdminConfig,
  CorpusInfo,
  CorpusJqlPreview,
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

/** Fresh admin-config draft for a corpus that has never been configured (`getConfig` reports
 *  `not_configured`). Deliberately carries NO secret fields — `apiToken`/`apiKey` are all
 *  `.optional()` on the wire, and the mask-omit save rule below only works if a brand-new draft
 *  never holds a mask to accidentally resend. */
const EMPTY_CONFIG: CorpusAdminConfig = {
  jira: { baseUrl: '', email: '', jql: '', includeComments: true },
  sync: { intervalMinutes: 60 },
  embedding: { endpoint: '', model: '' },
  llm: { provider: 'anthropic', model: '' },
  enrichment: { mode: 'off' }
}

const LLM_PROVIDERS = ['anthropic', 'openai-compatible'] as const
const ENRICHMENT_MODES = ['off', 'rules', 'on-first-hit'] as const

/** Cheap deep-equal for dirty tracking. `CorpusAdminConfig` is plain JSON (strings, numbers,
 *  booleans, enum strings — no Dates or functions), so a stringify compare is exact, and it
 *  treats an `undefined` secret field the same as an absent key, which is exactly the "not
 *  dirty" reading a freshly loaded draft should have. */
function sameConfig(a: CorpusAdminConfig, b: CorpusAdminConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** `forbidden` reads as "the token that passed Test lost admin scope since" — friendlier than
 *  the server's raw message, and worth special-casing because it names the fix (re-test).
 *  Every other code/message is shown verbatim: the dead-corpus rule means this never throws. */
function friendlyAdminError(res: { error: string; code?: string }): string {
  return res.code === 'forbidden' ? 'admin scope required — re-test the connection' : res.error
}

/** Deep-clones `draft` and drops any secret field left empty/undefined — the Global-Constraints
 *  mask rule. Omission means "keep what the server already has" (or, on a fresh draft, "none
 *  configured"); anything else, including an untouched `••••••` mask carried over from the
 *  load, is sent exactly as it sits in the draft. */
function stripEmptySecrets(draft: CorpusAdminConfig): CorpusAdminConfig {
  const body: CorpusAdminConfig = JSON.parse(JSON.stringify(draft)) as CorpusAdminConfig
  if (!body.jira.apiToken) delete body.jira.apiToken
  if (!body.embedding.apiKey) delete body.embedding.apiKey
  if (!body.llm.apiKey) delete body.llm.apiKey
  return body
}

/** Coerces a number-input string to a non-negative integer, per the spec's `intervalMinutes`
 *  rule — invalid/negative input (an empty field mid-edit, a pasted decimal) collapses to 0
 *  rather than propagating `NaN` into the draft. */
function coerceInterval(raw: string): number {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Compact labelled-field wrapper for the ingestion form — a visible caption plus whatever
 *  control follows, mirroring the aria-label-driven fields elsewhere in this file rather than
 *  an implicit `<label>` wrap (keeps every control's accessible name explicit and stable). */
function Field({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-mute">{label}</span>
      {children}
    </div>
  )
}

type JqlPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'result'; value: CorpusJqlPreview }
  | { status: 'error'; message: string }

/**
 * A JQL textarea plus its dry-run "Preview" affordance (corpus-admin-editor Task 6) — shared by
 * the Jira source's `jql` field and the enrichment `rulesJql` field, since both are just a JQL
 * string the corpus server can dry-run identically.
 *
 * Each instance owns its own `preview` state via its own `useState`, so mounting two of these
 * side by side (Jira JQL + Rules JQL) never shares a result between them — the isolation is
 * structural, not a flag this component has to manage. Preview always fires with the CURRENT
 * `jql` prop (the live draft), not whatever was loaded, and firing never touches `draft` itself
 * — Save and further edits stay live through a 'loading' preview exactly like every other async
 * affordance in this editor (Test, Sync now).
 *
 * `code === 'invalid_jql'` and every other failure (including a rejected IPC call, caught here)
 * render through the same `role="alert" text-danger` slot as the rest of this file's inline
 * errors — the brief's "same slot, error styling" distinguishes invalid_jql from a silent crash,
 * not from other failures, so one branch covers both.
 */
function JqlPreviewField({
  id,
  label,
  ariaLabel,
  previewAriaLabel,
  jql,
  onChange
}: {
  id: string
  label: string
  ariaLabel: string
  previewAriaLabel: string
  jql: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<JqlPreviewState>({ status: 'idle' })

  function runPreview(): void {
    if (!jql.trim() || preview.status === 'loading') return
    setPreview({ status: 'loading' })
    void window.argus.defects
      .jqlPreview(id, jql)
      .then((res) => {
        setPreview(
          res.ok ? { status: 'result', value: res.value } : { status: 'error', message: res.error }
        )
      })
      .catch((err: unknown) => {
        setPreview({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
  }

  return (
    <Field label={label}>
      <div className="flex flex-col gap-2">
        <textarea
          aria-label={ariaLabel}
          className={TEXTAREA_FIELD}
          rows={2}
          value={jql}
          onChange={(e) => onChange(e.target.value)}
        />
        <div>
          <Btn
            variant="outline"
            aria-label={previewAriaLabel}
            disabled={!jql.trim() || preview.status === 'loading'}
            onClick={runPreview}
          >
            {preview.status === 'loading' ? 'Previewing…' : 'Preview'}
          </Btn>
        </div>
        {preview.status === 'result' && (
          <div className="flex flex-col gap-0.5 text-xs text-dim">
            <span>{preview.value.count} matching tickets</span>
            {preview.value.sample.slice(0, 5).map((s) => (
              <span key={s.key} className="truncate font-mono">
                {s.key} — {s.summary}
              </span>
            ))}
          </div>
        )}
        {preview.status === 'error' && (
          <div role="alert" className="text-xs text-danger">
            {preview.message}
          </div>
        )}
      </div>
    </Field>
  )
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

/**
 * Per-source admin-config editor (corpus-admin-editor Task 5). Mounted by `SourceCard` only once
 * its last Test reported `capabilities.admin` — gating stays on the in-session Test result, same
 * as Sync now, per the design doc's non-goals (no persisted admin-capability flag).
 *
 * Owns its own expand/collapse and never unmounts on collapse: `load.status` (not `expanded`)
 * gates the `getConfig` call, so re-expanding after a clean collapse reuses the already-loaded
 * draft instead of re-fetching — the design doc's "first open" wording is doing real work here.
 * Collapsing with unsaved edits routes through `confirm()` (never `window.confirm`); on cancel
 * the draft and the expanded state are both left untouched.
 *
 * These corpus-side secrets (`jira.apiToken`, `embedding.apiKey`, `llm.apiKey`) live only in this
 * component's state and the PUT payload — never in `settingsStore`, the OS SecretStore, or any
 * log line, exactly like the connection-area `SecretInput` above.
 */
function IngestionEditor({
  id,
  onDirtyChange
}: {
  id: string
  /** Reserved for a future cross-card guard (e.g. warn on navigating away mid-edit); this
   *  component already handles its own collapse-confirm, so nothing here needs to react to it
   *  today — SourceCard passes a no-op. */
  onDirtyChange?: (dirty: boolean) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [load, setLoad] = useState<LoadState>({ status: 'idle' })
  const [note, setNote] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<CorpusAdminConfig | null>(null)
  const [draft, setDraft] = useState<CorpusAdminConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  const dirty = draft !== null && loaded !== null && !sameConfig(draft, loaded)

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  async function fetchConfig(): Promise<void> {
    setLoad({ status: 'loading' })
    try {
      const res = await window.argus.defects.getConfig(id)
      if (res.ok) {
        setLoaded(res.value)
        setDraft(res.value)
        setLoad({ status: 'ready' })
      } else if (res.code === 'not_configured') {
        setLoaded(EMPTY_CONFIG)
        setDraft(EMPTY_CONFIG)
        setNote("Not configured yet — saving creates this corpus's ingestion config.")
        setLoad({ status: 'ready' })
      } else {
        setLoad({ status: 'error', message: friendlyAdminError(res) })
      }
    } catch (err) {
      setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  function toggle(): void {
    if (expanded && dirty) {
      void confirm({
        title: 'Discard ingestion changes?',
        message: 'Unsaved edits to the ingestion settings will be lost.',
        confirmLabel: 'Discard',
        danger: true
      }).then((ok) => {
        if (!ok) return
        setDraft(loaded)
        setExpanded(false)
      })
      return
    }
    if (!expanded && load.status === 'idle') void fetchConfig()
    setExpanded((e) => !e)
  }

  function set<G extends keyof CorpusAdminConfig>(
    group: G,
    patch: Partial<CorpusAdminConfig[G]>
  ): void {
    setJustSaved(false)
    setDraft((d) => (d ? { ...d, [group]: { ...(d[group] as object), ...patch } } : d))
  }

  function save(): void {
    if (!draft || saving) return
    setSaving(true)
    setSaveError(null)
    void window.argus.defects
      .putConfig(id, stripEmptySecrets(draft))
      .then((res) => {
        if (res.ok) {
          setLoaded(res.value)
          setDraft(res.value)
          setJustSaved(true)
        } else {
          setSaveError(friendlyAdminError(res))
        }
      })
      .catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setSaving(false))
  }

  return (
    <SettingsSection title="Ingestion settings" collapsed={!expanded} onToggle={toggle}>
      {load.status === 'loading' && <div className="px-3 py-2 text-xs text-mute">Loading…</div>}
      {load.status === 'error' && (
        <div role="alert" className="px-3 py-2 text-xs text-danger">
          {load.message}
        </div>
      )}
      {load.status === 'ready' && draft && (
        <div className="flex flex-col gap-4 p-3">
          {note && <div className="text-xs text-mute">{note}</div>}

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-ink">Jira</span>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Base URL">
                <input
                  aria-label="Jira base URL"
                  className={FIELD}
                  value={draft.jira.baseUrl}
                  onChange={(e) => set('jira', { baseUrl: e.target.value })}
                />
              </Field>
              <Field label="Email">
                <input
                  aria-label="Jira email"
                  className={FIELD}
                  value={draft.jira.email}
                  onChange={(e) => set('jira', { email: e.target.value })}
                />
              </Field>
            </div>
            <Field label="API token">
              <input
                type="password"
                aria-label="Jira API token"
                className={FIELD}
                placeholder={draft.jira.apiToken ? undefined : 'not set'}
                value={draft.jira.apiToken ?? ''}
                onChange={(e) => set('jira', { apiToken: e.target.value })}
              />
            </Field>
            <JqlPreviewField
              id={id}
              label="JQL"
              ariaLabel="Jira JQL"
              previewAriaLabel="Preview Jira JQL"
              jql={draft.jira.jql}
              onChange={(v) => set('jira', { jql: v })}
            />
            <label className="flex items-center gap-2 text-xs text-mute">
              <Switch
                aria-label="Include comments"
                checked={draft.jira.includeComments}
                onChange={(v) => set('jira', { includeComments: v })}
              />
              Include comments
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-ink">Sync</span>
            <Field label="Interval (minutes)">
              <input
                type="number"
                min={0}
                aria-label="Sync interval (minutes)"
                className={FIELD}
                value={draft.sync.intervalMinutes}
                onChange={(e) => set('sync', { intervalMinutes: coerceInterval(e.target.value) })}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-ink">Embedding</span>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Endpoint">
                <input
                  aria-label="Embedding endpoint"
                  className={FIELD}
                  value={draft.embedding.endpoint}
                  onChange={(e) => set('embedding', { endpoint: e.target.value })}
                />
              </Field>
              <Field label="Model">
                <input
                  aria-label="Embedding model"
                  className={FIELD}
                  value={draft.embedding.model}
                  onChange={(e) => set('embedding', { model: e.target.value })}
                />
              </Field>
            </div>
            <Field label="API key">
              <input
                type="password"
                aria-label="Embedding API key"
                className={FIELD}
                placeholder={draft.embedding.apiKey ? undefined : 'not set'}
                value={draft.embedding.apiKey ?? ''}
                onChange={(e) => set('embedding', { apiKey: e.target.value })}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-ink">LLM</span>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Provider">
                <SelectField
                  aria-label="LLM provider"
                  value={draft.llm.provider}
                  options={LLM_PROVIDERS}
                  onChange={(v) =>
                    set('llm', { provider: v as CorpusAdminConfig['llm']['provider'] })
                  }
                />
              </Field>
              <Field label="Model">
                <input
                  aria-label="LLM model"
                  className={FIELD}
                  value={draft.llm.model}
                  onChange={(e) => set('llm', { model: e.target.value })}
                />
              </Field>
            </div>
            <Field label="API key">
              <input
                type="password"
                aria-label="LLM API key"
                className={FIELD}
                placeholder={draft.llm.apiKey ? undefined : 'not set'}
                value={draft.llm.apiKey ?? ''}
                onChange={(e) => set('llm', { apiKey: e.target.value })}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-ink">Enrichment</span>
            <Field label="Mode">
              <SelectField
                aria-label="Enrichment mode"
                value={draft.enrichment.mode}
                options={ENRICHMENT_MODES}
                onChange={(v) =>
                  set('enrichment', { mode: v as CorpusAdminConfig['enrichment']['mode'] })
                }
              />
            </Field>
            {draft.enrichment.mode === 'rules' && (
              <JqlPreviewField
                id={id}
                label="Rules JQL"
                ariaLabel="Enrichment rules JQL"
                previewAriaLabel="Preview enrichment rules JQL"
                jql={draft.enrichment.rulesJql ?? ''}
                onChange={(v) => set('enrichment', { rulesJql: v })}
              />
            )}
          </div>

          <div className="flex items-center gap-2">
            <Btn variant="outline" disabled={!dirty || saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </Btn>
            {justSaved && !dirty && <span className="text-xs text-dim">saved</span>}
            {saveError && (
              <span role="alert" className="text-xs text-danger">
                {saveError}
              </span>
            )}
          </div>
        </div>
      )}
    </SettingsSection>
  )
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
      {canSync && <IngestionEditor id={id} onDirtyChange={() => {}} />}
    </div>
  )
}

/**
 * Its own settings page (moved off Team, corpus-admin-editor Task 4) for the defect corpora this
 * workspace searches against (Task 8) — the same "shared upstream" idea as the HiveMind repo and
 * Confluence spaces on the Team page, but for ticket history instead of skills/references.
 * Sources live in `settings.defectCorpus.sources` (Task 1); their API tokens never do — those go
 * through `window.argus.secrets` only, exactly like every other credential in Settings.
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
