import { useEffect, useState } from 'react'
import { SettingsSection, SettingRow, Switch, DraftInput, FIELD } from './settingsLayout'
import { Btn, Chip } from '../ui'
import { settingsStore } from '../../lib/settingsStore'
import type { SettingsPayload } from '../../../../shared/settings'
import type { HealthCheckResult } from '../../../../shared/health'

const SECRET_NAME = 'observability/langfuse/secret-key'

/**
 * Ids match the StatCards currently rendered by ObservabilityView (Task 5) by
 * label, so a future pass can wire `hiddenCards` into that view's filtering
 * without renaming settings already saved by users. Not yet consumed there —
 * out of scope for this settings page.
 */
const DASHBOARD_CARDS = [
  { id: 'cost', label: 'Total cost' },
  { id: 'tokens', label: 'Tokens (in/out)' },
  { id: 'hitlApproval', label: 'HITL approval' },
  { id: 'toolDenials', label: 'Tool denials' },
  { id: 'findings', label: 'Findings' },
  { id: 'findingAcceptance', label: 'Finding acceptance' },
  { id: 'turnErrorRate', label: 'Turn error rate' },
  { id: 'turnLatency', label: 'Turn latency p50 / p95' },
  { id: 'costPerCase', label: 'Cost / resolved case' }
] as const

/**
 * Password input for the Langfuse secret key. Like the AnnotatedForm secret
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

export function ObservabilitySettings({
  payload
}: {
  payload: SettingsPayload
}): React.JSX.Element {
  const { langfuse, dashboard } = payload.settings.observability
  const [secretSet, setSecretSet] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<HealthCheckResult | null>(null)

  useEffect(() => {
    let mounted = true
    void window.argus.secrets.has(SECRET_NAME).then((v) => mounted && setSecretSet(v))
    return () => {
      mounted = false
    }
  }, [])

  function patchLangfuse(patch: Partial<typeof langfuse>): void {
    void settingsStore.patch({ observability: { langfuse: patch } })
  }

  function commitSecret(plaintext: string): void {
    void window.argus.secrets
      .set(SECRET_NAME, plaintext)
      .then(() => setSecretSet(true))
      .catch((err: Error) => window.alert(`secret not saved: ${err.message}`))
  }

  function toggleCard(id: string, hidden: boolean): void {
    const next = hidden
      ? [...dashboard.hiddenCards, id]
      : dashboard.hiddenCards.filter((c) => c !== id)
    void settingsStore.patch({ observability: { dashboard: { hiddenCards: next } } })
  }

  function testConnection(): void {
    if (testing) return
    setTesting(true)
    setTestResult(null)
    const off = window.argus.health.onResult((r) => {
      if (r.id === 'langfuse') setTestResult(r)
    })
    void window.argus.health.run(['langfuse']).finally(() => {
      setTesting(false)
      off()
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="Langfuse">
        <SettingRow
          label="Enable Langfuse"
          description="Send agent traces, cost, and latency data to a Langfuse instance."
        >
          <Switch
            checked={langfuse.enabled}
            onChange={(v) => patchLangfuse({ enabled: v })}
            aria-label="Enable Langfuse"
          />
        </SettingRow>
        <SettingRow label="Host URL" isDefault={langfuse.host === ''}>
          <DraftInput
            aria-label="Langfuse host URL"
            className={`${FIELD} w-72 font-mono`}
            placeholder="https://cloud.langfuse.com"
            value={langfuse.host}
            onCommit={(v) => patchLangfuse({ host: v.trim() })}
          />
        </SettingRow>
        <SettingRow label="Public key" isDefault={langfuse.publicKey === ''}>
          <DraftInput
            aria-label="Langfuse public key"
            className={`${FIELD} w-56 font-mono`}
            placeholder="pk-lf-…"
            value={langfuse.publicKey}
            onCommit={(v) => patchLangfuse({ publicKey: v.trim() })}
          />
        </SettingRow>
        <SettingRow label="Secret key" isDefault={!secretSet}>
          <SecretInput
            aria-label="Langfuse secret key"
            placeholder={secretSet ? '•••• (set)' : 'sk-lf-…'}
            onCommit={commitSecret}
          />
        </SettingRow>
        <SettingRow
          label="Test connection"
          description="Verifies the host and keys can reach your Langfuse instance."
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

      <SettingsSection title="Content capture">
        <SettingRow
          label="Capture content"
          description="Sends prompts, responses, and tool inputs/outputs — including confidential trace and ticket content — to your Langfuse instance."
        >
          <Switch
            checked={langfuse.captureContent}
            onChange={(v) => patchLangfuse({ captureContent: v })}
            aria-label="Capture content"
          />
        </SettingRow>
      </SettingsSection>

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
