import { useEffect, useRef, useState } from 'react'
import {
  SettingsSection,
  SettingRow,
  Switch,
  DraftInput,
  SelectField,
  FIELD
} from './settingsLayout'
import { Btn, Chip } from '../ui'
import { settingsStore } from '../../lib/settingsStore'
import { alert } from '../../lib/confirmStore'
import type { SettingsPayload } from '../../../../shared/settings'
import type { HealthCheckResult } from '../../../../shared/health'
import type { PolicyPayload } from '../../../../shared/policy'
import {
  OBSERVABILITY_PROVIDER_IDS,
  PROVIDER_DESCRIPTORS,
  secretName,
  type ObservabilityProviderId
} from '../../../../shared/observabilityProviders'

/**
 * Ids match the StatCards currently rendered by ObservabilityView (Task 5) by
 * label, so a future pass can wire `hiddenCards` into that view's filtering
 * without renaming settings already saved by users. Not yet consumed there —
 * out of scope for this settings page.
 */
export const DASHBOARD_CARDS = [
  { id: 'cost', label: 'Total cost' },
  { id: 'tokens', label: 'Tokens (in/out)' },
  { id: 'hitlApproval', label: 'HITL approval' },
  { id: 'toolDenials', label: 'Tool denials' },
  { id: 'findings', label: 'Findings' },
  { id: 'findingAcceptance', label: 'Finding acceptance' },
  { id: 'turnErrorRate', label: 'Turn error rate' },
  { id: 'turnLatency', label: 'Turn latency p50 / p95' },
  { id: 'costPerCase', label: 'Cost / resolved case' },
  // Ids below must match the `StatCard` `id`s rendered by DistillationCards.tsx (Task 13) —
  // two representations of one fact; keep them in sync.
  { id: 'distill.runs', label: 'Distillation runs' },
  { id: 'distill.spend', label: 'Distillation spend' },
  { id: 'distill.failedSpend', label: 'Failed-run spend' },
  { id: 'distill.drySpend', label: 'Dry-run spend' },
  // Must match the `data-card-id` on UsefulnessCards' root section.
  { id: 'usefulness.assets', label: 'Knowledge usefulness' }
] as const

/**
 * Password input for a provider secret (Langfuse secret key, OTLP authorization header). Like the AnnotatedForm secret
 * field, the draft starts empty and is cleared on commit/Escape so plaintext
 * never lingers in renderer state — only the placeholder signals set/not-set.
 */
function SecretInput({
  placeholder,
  onCommit,
  disabled,
  'aria-label': ariaLabel
}: {
  placeholder: string
  onCommit: (plaintext: string) => void
  disabled?: boolean
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
      disabled={disabled}
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

type ProviderCfg = Record<string, unknown> & { enabled: boolean; captureContent: boolean }
type ManagedProvider = NonNullable<PolicyPayload['observability'][ObservabilityProviderId]>

/** What a managed provider sends, in one line, so the user knows what the policy turned on. */
function managedSummary(label: string, m: ManagedProvider, cfg: ProviderCfg): string {
  if (m.error)
    return `Your organization's policy for ${label} is invalid, so it is switched off. Ask your IT administrator to fix it.`
  if (!cfg.enabled) return `Your organization's policy keeps ${label} switched off on this machine.`
  const what = cfg.captureContent
    ? 'traces, token usage, cost and scores, including prompts, responses and tool output'
    : 'traces, token usage, cost and scores (no prompts, responses or tool output)'
  const where = typeof cfg.site === 'string' && !m.customIntake ? ` (${cfg.site})` : ''
  const who = m.identifyUser ? ', tagged with your GitHub login' : ''
  return `Your organization's policy sends ${what} to ${label}${where}${who}. These settings cannot be changed here.`
}

/** How long Test connection waits for its health row before reporting "no response". */
const TEST_TIMEOUT_MS = 10_000

/**
 * One settings section per observability provider, rendered from the shared descriptor so the
 * page, the health rows and the exporter factory agree on a provider's fields. Aria-labels are
 * `Enable <label>`, `<label> <field label>` and `Capture content · <label>`.
 */
function ProviderSection({
  id,
  cfg: userCfg,
  managed
}: {
  id: ObservabilityProviderId
  cfg: ProviderCfg
  /** Present when an org policy manages this provider: its fields render read-only. */
  managed?: ManagedProvider
}): React.JSX.Element {
  const d = PROVIDER_DESCRIPTORS[id]
  // The policy's values win, exactly as main merges them for the exporter.
  const cfg: ProviderCfg = managed ? { ...userCfg, ...managed.values } : userCfg
  const locked = (key: string): boolean => managed?.managed.includes(key) ?? false
  const [secretSet, setSecretSet] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<HealthCheckResult | null>(null)
  /** Bumped per click so a stale run's late outcome never overwrites a newer one. */
  const runToken = useRef(0)

  useEffect(() => {
    let mounted = true
    // The descriptor is a module constant keyed by `id`, so `id` is the only real dependency.
    const keys = PROVIDER_DESCRIPTORS[id].fields
      .filter((f) => f.kind === 'secret')
      .map((f) => f.key)
    void Promise.all(
      keys.map((key) =>
        window.argus.secrets.has(secretName(id, key)).then((v) => [key, v] as const)
      )
    ).then((pairs) => {
      if (mounted) setSecretSet(Object.fromEntries(pairs))
    })
    return () => {
      mounted = false
    }
  }, [id])

  function patch(p: Record<string, unknown>): void {
    void settingsStore.patch({ observability: { providers: { [id]: p } } })
  }

  function commitSecret(key: string, plaintext: string): void {
    void window.argus.secrets
      .set(secretName(id, key), plaintext)
      .then(() => setSecretSet((s) => ({ ...s, [key]: true })))
      .catch((err: Error) => void alert(`secret not saved: ${err.message}`))
  }

  const rowId = `observability:${id}`
  function testConnection(): void {
    if (testing) return
    const token = ++runToken.current
    setTesting(true)
    setTestResult(null)
    let settled = false
    // Exactly one outcome per click: this row's result, the run's own failure, or — when neither
    // arrives in time — a visible "no response" failure instead of a silent button flip.
    const finish = (r: HealthCheckResult): void => {
      if (settled) return
      settled = true
      clearTimeout(fallback)
      off()
      if (runToken.current !== token) return
      setTestResult(r)
      setTesting(false)
    }
    const fail = (detail: string): void => finish({ id: rowId, label: d.label, ok: false, detail })
    const off = window.argus.health.onResult((r) => {
      if (r.id === rowId) finish(r)
    })
    const fallback = setTimeout(() => fail('no response from the health check'), TEST_TIMEOUT_MS)
    void window.argus.health
      .run([rowId])
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)))
  }
  const exportError = testResult?.ok === true && testResult.detail.includes('last export error')

  return (
    <SettingsSection
      title={d.label}
      action={
        managed ? (
          <Chip tone={managed.error ? 'danger' : 'signal'} aria-label={`${d.label} is managed`}>
            Managed by your organization
          </Chip>
        ) : undefined
      }
    >
      {managed && (
        <SettingRow
          label="Organization policy"
          description={
            <span data-testid={`policy-summary-${id}`}>
              {managedSummary(d.label, managed, cfg)}
            </span>
          }
        >
          {null}
        </SettingRow>
      )}
      <SettingRow label={`Enable ${d.label}`} description={d.description}>
        <Switch
          checked={cfg.enabled}
          disabled={locked('enabled')}
          onChange={(v) => patch({ enabled: v })}
          aria-label={`Enable ${d.label}`}
        />
      </SettingRow>
      {d.fields.map((f) => {
        const label = `${d.label} ${f.label}`
        const isLocked = locked(f.key)
        if (f.kind === 'secret')
          return (
            <SettingRow key={f.key} label={f.label} isDefault={isLocked || !secretSet[f.key]}>
              <SecretInput
                aria-label={label}
                disabled={isLocked}
                placeholder={
                  isLocked
                    ? '•••• (managed)'
                    : secretSet[f.key]
                      ? '•••• (set)'
                      : (f.placeholder ?? '')
                }
                onCommit={(v) => commitSecret(f.key, v)}
              />
            </SettingRow>
          )
        if (f.kind === 'select') {
          const options = f.options ?? []
          return (
            <SettingRow
              key={f.key}
              label={f.label}
              isDefault={isLocked || cfg[f.key] === options[0]}
            >
              <SelectField
                aria-label={label}
                disabled={isLocked}
                value={String(cfg[f.key] ?? options[0] ?? '')}
                options={options}
                onChange={(v) => patch({ [f.key]: v })}
              />
            </SettingRow>
          )
        }
        return (
          <SettingRow key={f.key} label={f.label} isDefault={isLocked || cfg[f.key] === ''}>
            <DraftInput
              aria-label={label}
              disabled={isLocked}
              className={`${FIELD} w-72${f.mono ? ' font-mono' : ''}`}
              placeholder={f.placeholder}
              value={String(cfg[f.key] ?? '')}
              onCommit={(v) => patch({ [f.key]: v.trim() })}
            />
          </SettingRow>
        )
      })}
      <SettingRow
        label="Capture content"
        description={`Sends prompts, responses, and tool inputs/outputs — including confidential trace and ticket content — to ${d.label}. Off by default.`}
      >
        <Switch
          checked={cfg.captureContent}
          disabled={locked('captureContent')}
          onChange={(v) => patch({ captureContent: v })}
          aria-label={`Capture content · ${d.label}`}
        />
      </SettingRow>
      <SettingRow
        label="Test connection"
        description={
          cfg.enabled
            ? `Verifies ${d.label} is reachable with this configuration.`
            : 'Enable the provider to test it.'
        }
      >
        <Btn variant="outline" disabled={testing || !cfg.enabled} onClick={testConnection}>
          {testing ? 'Testing…' : 'Test connection'}
        </Btn>
        {testResult &&
          (testResult.ok ? (
            // Reachable now, but the live sink latched a rejected export: say so, not a bare ok.
            <Chip tone={exportError ? 'defect' : 'review'} title={testResult.detail}>
              {exportError ? 'ok · export error' : 'ok'}
            </Chip>
          ) : (
            <Chip tone="danger" title={testResult.detail}>
              fail
            </Chip>
          ))}
      </SettingRow>
    </SettingsSection>
  )
}

export function ObservabilitySettings({
  payload,
  onOpenDashboard
}: {
  payload: SettingsPayload
  /** Opens the full-page metrics dashboard (App.tsx's `ObservabilityView`) — the dashboard's
   *  own entry point, now that the top bar no longer carries one directly. */
  onOpenDashboard?: () => void
}): React.JSX.Element {
  const { providers, dashboard } = payload.settings.observability
  const [policy, setPolicy] = useState<PolicyPayload | null>(null)

  useEffect(() => {
    const api = window.argus.policy
    if (!api) return
    let mounted = true
    void api.get().then((p) => {
      if (mounted) setPolicy(p)
    })
    const off = api.onChanged((p) => setPolicy(p))
    return () => {
      mounted = false
      off()
    }
  }, [])

  function toggleCard(id: string, hidden: boolean): void {
    const next = hidden
      ? [...dashboard.hiddenCards, id]
      : dashboard.hiddenCards.filter((c) => c !== id)
    void settingsStore.patch({ observability: { dashboard: { hiddenCards: next } } })
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="Dashboard">
        <SettingRow
          label="Metrics dashboard"
          description="Cost, tokens, findings, and latency across cases — the same view the top bar used to open directly."
        >
          <Btn onClick={onOpenDashboard}>Open dashboard</Btn>
        </SettingRow>
      </SettingsSection>

      {OBSERVABILITY_PROVIDER_IDS.map((id) => (
        <ProviderSection
          key={id}
          id={id}
          cfg={providers[id] as ProviderCfg}
          managed={policy?.observability[id]}
        />
      ))}

      <SettingsSection title="Dashboard cards">
        {DASHBOARD_CARDS.map((c) => {
          const hidden = dashboard.hiddenCards.includes(c.id)
          return (
            <SettingRow key={c.id} label={c.label} isDefault={!hidden}>
              <label className="flex items-center gap-2 text-xs text-dim">
                <input
                  type="checkbox"
                  aria-label={`Show ${c.label}`}
                  checked={!hidden}
                  onChange={(e) => toggleCard(c.id, !e.target.checked)}
                />
                visible
              </label>
            </SettingRow>
          )
        })}
      </SettingsSection>
    </div>
  )
}
