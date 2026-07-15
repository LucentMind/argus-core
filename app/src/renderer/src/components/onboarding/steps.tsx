import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthStatus } from '../../../../shared/types'
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
        Argus analyzes defect evidence with an embedded Claude agent. The next minute gets you set
        up: connect Claude, install a pack, optionally link your tools, and open a sample case.
      </p>
    </div>
  )
}

export function ClaudeStep({ setGate }: { setGate: (ok: boolean) => void }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const alive = useRef(true)

  // Apply a resolved auth status. Guarded so a probe that settles after the step
  // unmounts (the wizard may advance while a re-check is in flight) is a no-op.
  const settle = useCallback(
    (s: AuthStatus) => {
      if (!alive.current) return
      setStatus(s)
      setGate(s.ok)
      setChecking(false)
    },
    [setGate]
  )

  // Apply a probe rejection: surface it as a failed status so `checking` doesn't
  // get stuck true and the gate stays closed.
  const fail = useCallback(
    (e: unknown) => {
      if (!alive.current) return
      setStatus({ ok: false, detail: e instanceof Error ? e.message : String(e) })
      setGate(false)
      setChecking(false)
    },
    [setGate]
  )

  useEffect(() => {
    alive.current = true
    // setState happens only inside the async .then callbacks, never synchronously
    // in the effect body — mirrors AgentSettings.tsx to avoid set-state-in-effect.
    void window.argus.agent.authStatus(false).then(
      (s) => settle(s),
      (e) => fail(e)
    )
    return () => {
      alive.current = false
    }
  }, [settle, fail])

  // Re-check: clear the stale result first so the "Checking…" line replaces the
  // prior guidance rather than rendering alongside it. Runs in an event handler,
  // so the synchronous setState here is fine.
  function recheck(): void {
    setStatus(null)
    setChecking(true)
    void window.argus.agent.authStatus(true).then(
      (s) => settle(s),
      (e) => fail(e)
    )
  }

  return (
    <div className="space-y-3">
      <h2 className="text-lg text-ink">Connect Claude</h2>
      {checking && <p className="text-sm text-dim">Checking Claude login…</p>}
      {status?.ok && (
        <p className="text-sm text-signal">
          Logged in as {status.email ?? 'your account'}
          {status.subscription ? ` (${status.subscription})` : ''}.
        </p>
      )}
      {status && !status.ok && (
        <div className="space-y-2">
          <p className="text-sm text-danger">Claude isn’t logged in — the agent can’t run yet.</p>
          <p className="text-xs text-dim">
            Install the Claude Code CLI and run <code className="text-ink">claude login</code> in a
            terminal, then re-check.
          </p>
          <button
            className="rounded-r2 border border-hair px-3 py-1.5 text-xs text-ink"
            onClick={recheck}
          >
            Re-check
          </button>
        </div>
      )}
    </div>
  )
}

export function PackStep({
  setGate,
  onOpenSettings
}: {
  setGate: (ok: boolean) => void
  /** Open the Packs settings page (to install a pack) — the wizard is hidden while there. */
  onOpenSettings?: () => void
}): React.JSX.Element {
  const [payload, setPayload] = useState<PacksListPayload | null>(null)
  // Resolve via .then so setState happens only inside the async callback, never
  // synchronously in the effect body — mirrors ClaudeStep to avoid set-state-in-effect.
  const load = useCallback(() => {
    void window.argus.packs.list().then((p) => {
      setPayload(p)
      setGate(p.packs.length > 0)
    })
  }, [setGate])
  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="space-y-3">
      <h2 className="text-lg text-ink">Install a pack</h2>
      <p className="text-sm text-dim">
        Argus Core is domain-free — packs add the detectors, skills, and tools for your evidence.
      </p>
      {payload && payload.packs.length > 0 ? (
        <ul className="space-y-1 text-sm text-ink">
          {payload.packs.map((p) => (
            <li key={p.id} className="rounded-r2 border border-hair px-3 py-1.5">
              {p.displayName}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-danger">
          No packs installed yet. Install one in Packs settings, then re-check.
        </p>
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

/** Ensure a `rovo` (Atlassian) connector instance exists, then run its OAuth flow. */
function connectAtlassian(
  connectors: ReturnType<typeof connectorsStore.get>,
  onError: (msg: string) => void,
  onDone: () => void
): void {
  const preset = connectors?.presets?.rovo
  const exists = Boolean(connectors?.connectors?.rovo)
  const ensure =
    exists || !preset
      ? Promise.resolve()
      : connectorsStore.patch({
          rovo: {
            kind: preset.kind,
            displayName: preset.displayName,
            preset: 'rovo',
            enabled: true,
            config: preset.config
          }
        })
  void ensure
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
          <div className="flex items-center gap-2">
            <button
              className="rounded-r2 border border-hair px-3 py-1.5 text-xs text-ink hover:bg-hair disabled:opacity-40"
              disabled={connecting}
              onClick={connect}
            >
              {connecting ? 'Connecting…' : 'Connect Atlassian'}
            </button>
            {authError && <span className="text-xs text-danger">{authError}</span>}
          </div>
        }
      />
      <IntegrationCard
        name="HiveMind repo"
        hint="Share skills and memory with your team."
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
