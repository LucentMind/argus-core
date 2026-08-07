import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { agentStore, EMPTY_CASE_AGENT_STATE } from '../lib/agentStore'
import { useSettingsPayload } from '../lib/settingsStore'
import { uiStore } from '../lib/uiStore'
import { checkDetail } from '../lib/preflightDetail'
import { ContextGauge } from './ContextGauge'
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
  // Read directly rather than relying on a `.dyn` ancestor: the gauge is chosen by this
  // component, so it must not depend on which scope wrapper happens to enclose the strip.
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const dynamic = ui.dynamicTheme
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
  // `verified` means "a real turn has proven these credentials work" (AuthCache.onAuthVerified).
  // Until then the probe's green is provisional — it runs with maxTurns:0 and never contacts the
  // API. The old wording said "confirmed on your first message", which reads as a completed fact
  // and directly contradicted the "ready (unconfirmed)" line right above it. State the pending
  // condition instead, so both lines say the same thing.
  const authDetail = auth
    ? auth.ok && !auth.verified
      ? `${auth.detail} — sign-in not confirmed yet; sending your first message confirms it`
      : auth.detail
    : 'probing agent…'
  const title = [
    authDetail,
    preflight
      ? preflight.checks
          .map((c) => [`${c.ok ? '✓' : '✗'} ${c.name}`, checkDetail(c)].filter(Boolean).join(': '))
          .join('\n')
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

  // Clamped, not just rounded: a window can be exceeded briefly before the CLI compacts, and a
  // bar wider than its own pill would paint outside the border radius.
  const { usedTokens, contextWindow } = state.context
  const contextPct =
    usedTokens !== null && contextWindow !== null && contextWindow > 0
      ? Math.min(100, Math.max(0, (usedTokens / contextWindow) * 100))
      : null
  const contextLabel =
    contextPct === null || contextWindow === null
      ? null
      : `${Math.round(contextPct)}% of ${contextWindow.toLocaleString()}`

  return (
    <div
      className="relative flex shrink-0 items-center gap-2"
      data-testid="session-chips"
      ref={ref}
    >
      {/* Fixed width (w-24), not hug: the gauge inside is a proportion of the pill, so a pill
          that resized with its label ("checking…" → "ready") would redraw the same percentage
          at a different length. */}
      <button
        type="button"
        title={contextPct === null ? title : `context ${Math.round(contextPct)}% full\n\n${title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Session status"
        onClick={() => setOpen((o) => !o)}
        className={`relative inline-flex w-24 items-center justify-center overflow-hidden rounded-r1 border px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wide transition-colors hover:brightness-110 ${PILL_TONES[tone]}`}
      >
        {/* Context gauge. Both renderings take their colour from `currentColor`, so the gauge
            tracks the tone the pill already carries instead of introducing a fourth status
            colour — and follows the theme for free. */}
        {contextPct !== null && (
          <ContextGauge
            pct={contextPct}
            dynamic={dynamic}
            toneKey={tone}
            light={ui.theme === 'light'}
          />
        )}
        {/* Ink, not the status tone — and this is a fix, not a preference. A tone-coloured label
            on a tone-coloured fill cannot reach AA at ANY gauge brightness: measured worst-case
            under the glyphs it tops out at 2.4:1 in light even with the gauge dimmed to nothing,
            and it is 2.9:1 with no gauge at all. Ink measures 8.2:1 light / 5.1:1 dark against
            the same worst case. Status is still carried by the border and the fill; this only
            moves the *glyphs* off the same hue as their own background.

            The button keeps `text-<tone>`, so `currentColor` — which is what BOTH gauge
            renderings read their colour from — is unchanged. */}
        <span className="relative text-ink">{label}</span>
      </button>
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
                {preflight.checks.map((c) => {
                  const detail = checkDetail(c)
                  return (
                    <li key={c.name} className={c.ok ? '' : 'text-danger'}>
                      {c.ok ? '✓' : '✗'} {c.name}
                      {detail ? `: ${detail}` : ''}
                    </li>
                  )
                })}
              </ul>
            )}
            {contextLabel !== null && (
              <div className="flex items-center justify-between gap-3 border-t border-hair pt-2">
                <dt className="text-mute">Context</dt>
                <dd className="text-ink">{contextLabel}</dd>
              </div>
            )}
            <div
              className={`flex items-center justify-between gap-3 ${contextLabel === null ? 'border-t border-hair pt-2' : ''}`}
            >
              <dt className="text-mute">Tokens</dt>
              <dd className="text-ink">{tokens.toLocaleString()}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              {/* The SDK reports list price. On a subscription the marginal cost of these tokens
                  is lower (often zero) — say so, rather than let a $89 readout imply a bill. */}
              <dt className="text-mute">
                Est. cost <span className="text-faint">(actual cost is lower)</span>
              </dt>
              <dd className="shrink-0 text-ink">{costLabel}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  )
}
