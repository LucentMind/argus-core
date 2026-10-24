import { useEffect, useState } from 'react'
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

type ProviderCfg = Record<string, unknown> & { enabled: boolean; captureContent: boolean }

/**
 * One settings section per observability provider, rendered from the shared descriptor so the
 * page, the health rows and the exporter factory agree on a provider's fields. Aria-labels are
 * `Enable <label>`, `<label> <field label>` and `Capture content · <label>`.
 */
function ProviderSection({
  id,
  cfg
}: {
  id: ObservabilityProviderId
  cfg: ProviderCfg
}): React.JSX.Element {
  const d = PROVIDER_DESCRIPTORS[id]
  const [secretSet, setSecretSet] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<HealthCheckResult | null>(null)

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
    setTesting(true)
    setTestResult(null)
    const off = window.argus.health.onResult((r) => {
      if (r.id === rowId) setTestResult(r)
    })
    void window.argus.health.run([rowId]).finally(() => {
      setTesting(false)
      off()
    })
  }

  return (
    <SettingsSection title={d.label}>
      <SettingRow label={`Enable ${d.label}`} description={d.description}>
        <Switch
          checked={cfg.enabled}
          onChange={(v) => patch({ enabled: v })}
          aria-label={`Enable ${d.label}`}
        />
      </SettingRow>
      {d.fields.map((f) => {
        const label = `${d.label} ${f.label}`
        if (f.kind === 'secret')
          return (
            <SettingRow key={f.key} label={f.label} isDefault={!secretSet[f.key]}>
              <SecretInput
                aria-label={label}
                placeholder={secretSet[f.key] ? '•••• (set)' : (f.placeholder ?? '')}
                onCommit={(v) => commitSecret(f.key, v)}
              />
            </SettingRow>
          )
        if (f.kind === 'select') {
          const options = f.options ?? []
          return (
            <SettingRow key={f.key} label={f.label} isDefault={cfg[f.key] === options[0]}>
              <SelectField
                aria-label={label}
                value={String(cfg[f.key] ?? options[0] ?? '')}
                options={options}
                onChange={(v) => patch({ [f.key]: v })}
              />
            </SettingRow>
          )
        }
        return (
          <SettingRow key={f.key} label={f.label} isDefault={cfg[f.key] === ''}>
            <DraftInput
              aria-label={label}
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
          onChange={(v) => patch({ captureContent: v })}
          aria-label={`Capture content · ${d.label}`}
        />
      </SettingRow>
      <SettingRow
        label="Test connection"
        description={`Verifies ${d.label} is reachable with this configuration.`}
      >
        <Btn variant="outline" disabled={testing} onClick={testConnection}>
          {testing ? 'Testing…' : 'Test connection'}
        </Btn>
        {testResult &&
          (testResult.ok ? (
            <Chip tone="review">ok</Chip>
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
        <ProviderSection key={id} id={id} cfg={providers[id] as ProviderCfg} />
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
