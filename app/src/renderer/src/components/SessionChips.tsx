import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { agentStore, EMPTY_CASE_AGENT_STATE } from '../lib/agentStore'
import { useSettingsPayload } from '../lib/settingsStore'
import { capabilitiesFor, defaultInstanceId } from '../../../shared/drivers'
import type { AuthStatus, PreflightReport } from '../../../shared/types'

/** Tinted background + border per tone, so the pill reads as a status light rather than a plain
 *  label — `Chip`'s own `bg-hair/50` is deliberately near-invisible everywhere else it is used
 *  (badge counts sitting on already-busy cards), which is wrong for the one status a user checks
 *  before trusting the chat to actually run. */
const PILL_TONES = {
  neutral: 'border-hair bg-hair text-dim',
  review: 'border-review/40 bg-review/20 text-review',
  danger: 'border-danger/40 bg-danger/20 text-danger'
} as const

/**
 * Readiness and cost for the chat this panel is showing.
 *
 * These are facts about *the agent running this chat*, not about the case: a chat's
 * provider is per-session after the multi-provider work, and `costReporting` is a
 * per-provider capability. They sat in the case header only because the case header
 * existed.
 *
 * Auth and preflight are one chip rather than two. That is load-bearing, not cosmetic —
 * the chat column is ~640px with both rails open at 1280, and two separate chips put this
 * row into the search field. The failure labels stay distinct (`agent ✗` vs `tools ✗`) so
 * the merge costs no diagnostic information.
 */
export function SessionChips({
  slug,
  sessionId,
  instanceId = null
}: {
  slug: string
  sessionId: number | null
  /** Provider instance running this chat — cost reporting is a per-provider capability
   *  (Copilot reports none), so it must not be read off the global default. */
  instanceId?: string | null
}): React.JSX.Element {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [preflight, setPreflight] = useState<PreflightReport | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const state = useSyncExternalStore(
    (cb) => agentStore.subscribe(cb),
    () => (sessionId === null ? EMPTY_CASE_AGENT_STATE : agentStore.get(slug, sessionId))
  )
  const settingsPayload = useSettingsPayload()
  const costReporting = capabilitiesFor(
    settingsPayload?.settings,
    instanceId ?? (settingsPayload ? defaultInstanceId(settingsPayload.settings) : null)
  ).costReporting

  useEffect(() => {
    // authStatus() can be in flight when agent:auth-changed fires (e.g. a turn 401s right
    // after mount). Without a sequence guard the stale mount-time probe can resolve AFTER
    // the refresh the broadcast triggered and overwrite the correct (red) verdict back to
    // green — a last-write-wins hazard, not just an unmount race.
    let seq = 0
    const refresh = (): void => {
      const mySeq = ++seq
      void window.argus.agent.authStatus().then((status) => {
        if (mySeq === seq) setAuth(status)
      })
    }
    refresh()
    void window.argus.agent.preflight().then(setPreflight)
    const unsubscribe = window.argus.agent.onAuthChanged(refresh)
    return () => {
      seq = -1
      unsubscribe()
    }
  }, [])

  // Same click-outside/Escape pattern as `MenuButton` (ui.tsx) — this isn't built on that
  // component because its items are actionable menu rows, not a read-only status readout.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const probing = !auth || !preflight
  const label = probing
    ? 'checking…'
    : !auth.ok
      ? 'agent ✗'
      : !preflight.ok
        ? 'tools ✗'
        : auth.verified
          ? 'ready'
          : 'ready ~'
  const tone = probing
    ? 'neutral'
    : !auth.ok || !preflight.ok
      ? 'danger'
      : auth.verified
        ? 'review'
        : 'neutral'
  const authDetail = auth
    ? auth.ok && !auth.verified
      ? `${auth.detail} — confirmed on your first message`
      : auth.detail
    : 'probing agent…'
  const title = [
    authDetail,
    preflight
      ? preflight.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n')
      : 'running preflight…'
  ]
    .filter(Boolean)
    .join('\n')

  const tokens = state.cost.inputTokens + state.cost.outputTokens
  // Mirrors the suffix logic below: no cost yet is a blank dash, not a measured $0.00.
  const costLabel = !costReporting
    ? 'n/a'
    : state.cost.costUsd > 0
      ? `$${state.cost.costUsd.toFixed(2)}`
      : '—'

  return (
    <div
      className="relative flex shrink-0 items-center gap-2"
      data-testid="session-chips"
      ref={ref}
    >
      <button
        type="button"
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Session status"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1 rounded-r1 border px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wide transition-colors hover:brightness-110 ${PILL_TONES[tone]}`}
      >
        {label}
      </button>
      <span className="whitespace-nowrap font-mono text-[10.5px] uppercase tracking-wide text-mute">
        {tokens.toLocaleString()} tok
        {/* costReporting=false (e.g. Copilot v1) never accumulates a real cost — say so
            instead of rendering the accumulator's initial 0 as a measured $0.00 turn. */}
        {!costReporting
          ? ' · n/a'
          : state.cost.costUsd > 0
            ? ` · $${state.cost.costUsd.toFixed(2)}`
            : ''}
      </span>
      {open && (
        <div
          role="dialog"
          aria-label="Session status"
          data-testid="session-status-popover"
          className="overlay-menu absolute left-0 top-full z-30 mt-1 w-64 rounded-r2 p-3 text-[11px] normal-case"
        >
          <dl className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-mute">Agent</dt>
              <dd
                className={`text-right ${!auth ? 'text-mute' : auth.ok ? 'text-review' : 'text-danger'}`}
              >
                {!auth
                  ? 'checking…'
                  : auth.ok
                    ? auth.verified
                      ? 'ready'
                      : 'ready (unconfirmed)'
                    : 'failed'}
              </dd>
            </div>
            <p className="text-mute">{authDetail}</p>
            <div className="flex items-start justify-between gap-3 border-t border-hair pt-2">
              <dt className="shrink-0 text-mute">Tools</dt>
              <dd
                className={`text-right ${!preflight ? 'text-mute' : preflight.ok ? 'text-review' : 'text-danger'}`}
              >
                {!preflight ? 'checking…' : preflight.ok ? 'all passed' : 'failed'}
              </dd>
            </div>
            {preflight && preflight.checks.length > 0 && (
              <ul className="flex flex-col gap-0.5 text-mute">
                {preflight.checks.map((c) => (
                  <li key={c.name} className={c.ok ? '' : 'text-danger'}>
                    {c.ok ? '✓' : '✗'} {c.name}: {c.detail}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between gap-3 border-t border-hair pt-2">
              <dt className="text-mute">Tokens</dt>
              <dd className="text-ink">{tokens.toLocaleString()}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-mute">Est. cost</dt>
              <dd className="text-ink">{costLabel}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  )
}
