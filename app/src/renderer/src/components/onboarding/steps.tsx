import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthStatus } from '../../../../shared/types'
import type { PacksListPayload } from '../../../../shared/packs'

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

export function PackStep({ setGate }: { setGate: (ok: boolean) => void }): React.JSX.Element {
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
          No packs installed yet. Open Packs settings to add one, then re-check.
        </p>
      )}
      <button className="rounded-r2 border border-hair px-3 py-1.5 text-xs text-ink" onClick={load}>
        Re-check
      </button>
    </div>
  )
}
