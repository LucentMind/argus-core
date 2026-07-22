import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderStatus } from '../../../../shared/types'
import type { PacksListPayload } from '../../../../shared/packs'
import { markIntegration, markPhase1Done } from '../../lib/onboardingStore'
import { settingsStore, useSettingsPayload } from '../../lib/settingsStore'
import { connectorsStore, useConnectorsPayload } from '../../lib/connectorsStore'
import { DraftInput, FIELD } from '../settings/settingsLayout'

export function WelcomeStep(): React.JSX.Element {
  return (
    <div className="space-y-3">
      <h2 className="text-lg text-ink">Welcome to Argus</h2>
      <p className="text-sm text-dim">
        Argus analyzes defect evidence with an embedded coding agent. The next minute gets you set
        up: connect a provider, install a pack, optionally link your tools, and open a sample case.
      </p>
    </div>
  )
}

/**
 * Provider connection step.
 *
 * Lists EVERY configured provider with its own state rather than naming one, because several
 * can be enabled at once and the chat's model picker draws from all of them. Naming a single
 * provider here was actively misleading: a user with both Claude and Copilot configured saw
 * only whichever happened to be the default.
 *
 * The gate opens as soon as ONE provider is ready — that is enough to run the agent. The
 * others are shown with their own remediation so a half-configured setup is visible rather
 * than silently ignored, but they never block finishing setup.
 */
export function ProviderStep({ setGate }: { setGate: (ok: boolean) => void }): React.JSX.Element {
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null)
  const [checking, setChecking] = useState(true)
  const alive = useRef(true)

  // Guarded so a probe settling after the step unmounts (the wizard may advance while a
  // re-check is in flight) is a no-op.
  const settle = useCallback(
    (list: ProviderStatus[]) => {
      if (!alive.current) return
      setStatuses(list)
      setGate(list.some((s) => s.state === 'ready'))
      setChecking(false)
    },
    [setGate]
  )

  const fail = useCallback(
    (e: unknown) => {
      if (!alive.current) return
      setStatuses([])
      setGate(false)
      setChecking(false)
      console.error('provider status failed', e)
    },
    [setGate]
  )

  useEffect(() => {
    alive.current = true
    // setState happens only inside the async .then callbacks, never synchronously in the
    // effect body — mirrors AgentSettings.tsx to avoid set-state-in-effect.
    void window.argus.providers.statuses().then(
      (l) => settle(l),
      (e) => fail(e)
    )
    return () => {
      alive.current = false
    }
  }, [settle, fail])

  function recheck(): void {
    setStatuses(null)
    setChecking(true)
    void window.argus.providers.refresh().then(
      (l) => settle(l),
      (e) => fail(e)
    )
  }

  const ready = statuses?.filter((s) => s.state === 'ready') ?? []
  const notReady = statuses?.filter((s) => s.state !== 'ready') ?? []

  return (
    <div className="space-y-3">
      <h2 className="text-lg text-ink">Connect a provider</h2>
      {checking && <p className="text-sm text-dim">Checking your providers…</p>}
      {statuses && statuses.length === 0 && !checking && (
        <p className="text-sm text-danger">
          No providers are enabled — add one in Settings → Agent before continuing.
        </p>
      )}
      {ready.length > 0 && (
        <p className="text-sm text-signal">
          {ready.map((s) => s.displayName).join(' and ')} {ready.length === 1 ? 'is' : 'are'} ready.
          Sign-in is confirmed on your first message.
        </p>
      )}
      {statuses && statuses.length > 0 && (
        <ul className="space-y-1">
          {statuses.map((s) => (
            <li
              key={s.instanceId}
              className="flex items-start gap-2 rounded-r2 border border-hair px-3 py-2"
            >
              <span
                aria-hidden
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  s.state === 'ready' ? 'bg-review' : s.state === 'error' ? 'bg-danger' : 'bg-faint'
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="text-sm text-ink">{s.displayName}</span>
                <span className="block text-xs text-mute">
                  {s.state === 'ready' && s.email ? `Authenticated as ${s.email}` : s.detail}
                </span>
                {/* Driver-supplied remediation (AgentDriver.authFixHint) — never another
                    vendor's advice. */}
                {s.state === 'error' && s.fixHint && (
                  <span className="block text-xs text-dim">{s.fixHint}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {notReady.length > 0 && ready.length > 0 && (
        <p className="text-xs text-mute">
          You can finish setup now — the others can be connected later from Settings → Agent.
        </p>
      )}
      {!checking && (
        <button
          className="rounded-r2 border border-hair px-3 py-1.5 text-xs text-ink"
          onClick={recheck}
        >
          Re-check
        </button>
      )}
    </div>
  )
}

// Final, NON-gating step: the user can finish setup or install a domain pack.
// (Core ships with sample packs, so a fresh install is never a dead end here.)
export function PackStep({
  onOpenSettings
}: {
  /** Open the Packs settings page (to install a pack) — the wizard is hidden while there. */
  onOpenSettings?: () => void
}): React.JSX.Element {
  const [payload, setPayload] = useState<PacksListPayload | null>(null)
  // Resolve via .then so setState happens only inside the async callback, never
  // synchronously in the effect body — mirrors ProviderStep to avoid set-state-in-effect.
  const load = useCallback(() => {
    void window.argus.packs.list().then((p) => setPayload(p))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="space-y-3">
      <h2 className="text-lg text-ink">You’re set up</h2>
      <p className="text-sm text-dim">
        Install a domain pack to analyze your own evidence — it adds the detectors, skills, and
        tools for your file formats. You can finish now and add one anytime from Settings.
      </p>
      {payload && payload.packs.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-faint">Installed packs</p>
          <ul className="space-y-1 text-sm text-ink">
            {payload.packs.map((p) => (
              <li key={p.id} className="rounded-r2 border border-hair px-3 py-1.5">
                {p.displayName}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2">
        {onOpenSettings && (
          <button
            className="rounded-r2 border border-hair px-3 py-1.5 text-xs text-ink hover:bg-hair"
            onClick={onOpenSettings}
          >
            Install a pack…
          </button>
        )}
        <button
          className="rounded-r2 border border-hair px-3 py-1.5 text-xs text-ink"
          onClick={load}
        >
          Re-check
        </button>
      </div>
    </div>
  )
}

// Declared outside IntegrationsStep (not nested) so it isn't recreated every render —
// satisfies react-hooks/static-components. `action` is the inline configure control
// (a field or button) shown while the integration is not yet configured.
function IntegrationCard({
  name,
  hint,
  ok,
  action
}: {
  name: string
  hint: string
  ok: boolean
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-r2 border border-hair px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-ink">{name}</span>
        <span className={`text-xs ${ok ? 'text-signal' : 'text-faint'}`}>
          {ok ? 'Configured' : 'Not set up'}
        </span>
      </div>
      <p className="mt-1 text-xs text-dim">{hint}</p>
      {!ok && action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/** Create the `rovo` (Atlassian) connector instance from its preset if it doesn't exist yet. */
function ensureRovo(connectors: ReturnType<typeof connectorsStore.get>): Promise<void> {
  if (connectors?.connectors?.rovo) return Promise.resolve()
  const preset = connectors?.presets?.rovo
  if (!preset) return Promise.resolve()
  return connectorsStore.patch({
    rovo: {
      kind: preset.kind,
      displayName: preset.displayName,
      preset: 'rovo',
      enabled: true,
      config: preset.config
    }
  })
}

/** Ensure a `rovo` (Atlassian) connector instance exists, then run its OAuth flow. */
function connectAtlassian(
  connectors: ReturnType<typeof connectorsStore.get>,
  onError: (msg: string) => void,
  onDone: () => void
): void {
  void ensureRovo(connectors)
    .then(() => window.argus.connectors.oauth('rovo'))
    .then((r: { ok: boolean; error?: string }) => {
      if (!r.ok) onError(r.error ?? 'authorization failed')
    })
    .catch((e) => onError(e instanceof Error ? e.message : String(e)))
    .finally(onDone)
}

export function IntegrationsStep(): React.JSX.Element {
  const settings = useSettingsPayload()
  const connectors = useConnectorsPayload()
  const [connecting, setConnecting] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  const hive = Boolean(settings?.settings?.hivemind?.repo?.trim())
  const atlassian = Object.values(connectors?.oauth ?? {}).some((v) => v === 'authorized')

  // Record the onboarding flags reactively as each integration becomes configured.
  // These call settingsStore.patch (an async store update, not a local setState), so
  // they don't trip react-hooks/set-state-in-effect; deps gate them to one write per flip.
  useEffect(() => {
    if (atlassian) {
      void markIntegration('jira', true)
      void markIntegration('confluence', true)
    }
  }, [atlassian])
  useEffect(() => {
    if (hive) void markIntegration('hive', true)
  }, [hive])

  function connect(): void {
    setConnecting(true)
    setAuthError(null)
    connectAtlassian(connectors, setAuthError, () => setConnecting(false))
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg text-ink">Connect your tools (optional)</h2>
      <p className="text-sm text-dim">
        Configure these now and the tour will show them working on real data. You can skip any and
        set them up later in Settings.
      </p>
      <IntegrationCard
        name="Atlassian (Jira & Confluence)"
        hint="Create cases from Jira tickets and sync Confluence reference docs the agent can cite."
        ok={atlassian}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-r2 border border-hair px-3 py-1.5 text-xs text-ink hover:bg-hair disabled:opacity-40"
              disabled={connecting}
              onClick={connect}
            >
              {connecting ? 'Connecting…' : 'Connect Atlassian'}
            </button>
            <span className="text-xs text-faint">(agent · MCP)</span>
            {authError && <span className="text-xs text-danger">{authError}</span>}
          </div>
        }
      />
      <IntegrationCard
        name="HiveMind repo"
        hint="Share skills and reference docs with your team."
        ok={hive}
        action={
          <DraftInput
            aria-label="HiveMind repo"
            className={`${FIELD} w-56 font-mono`}
            placeholder="org/name"
            value={settings?.settings.hivemind.repo ?? ''}
            onCommit={(v) => void settingsStore.patch({ hivemind: { repo: v.trim() } })}
          />
        }
      />
    </div>
  )
}

export function SeedStep({
  setGate,
  onSeeded
}: {
  setGate: (ok: boolean) => void
  onSeeded: (slug: string) => void
}): React.JSX.Element {
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    // Disable Finish until the sample case is seeded. Deferred to a microtask so
    // it's an async continuation (avoids react-hooks/set-state-in-effect), same
    // technique as the wizard's async-gating test. On error the gate stays false.
    void Promise.resolve().then(() => setGate(false))
    window.argus.onboarding
      .seedSample()
      .then((r) =>
        markPhase1Done(r.slug).then(() => {
          setDone(true)
          setGate(true)
          onSeeded(r.slug)
        })
      )
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [setGate, onSeeded])

  return (
    <div className="space-y-3">
      <h2 className="text-lg text-ink">Your sample case</h2>
      {!done && !error && <p className="text-sm text-dim">Setting up a sample case to explore…</p>}
      {done && (
        <p className="text-sm text-signal">
          Sample case ready. Finish to open it and take the feature tour.
        </p>
      )}
      {error && <p className="text-sm text-danger">Couldn&apos;t seed the sample case: {error}</p>}
    </div>
  )
}
