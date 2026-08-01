import { useEffect, useState, useSyncExternalStore } from 'react'
import { Chip } from './ui'
import { agentStore, EMPTY_CASE_AGENT_STATE } from '../lib/agentStore'
import { useSettingsPayload } from '../lib/settingsStore'
import { capabilitiesFor, defaultInstanceId } from '../../../shared/drivers'
import type { AuthStatus, PreflightReport } from '../../../shared/types'

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
  const title = [
    auth
      ? auth.ok && !auth.verified
        ? `${auth.detail} — confirmed on your first message`
        : auth.detail
      : 'probing agent…',
    preflight
      ? preflight.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n')
      : 'running preflight…'
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span title={title}>
        <Chip tone={tone}>{label}</Chip>
      </span>
      <span className="whitespace-nowrap font-mono text-[10.5px] uppercase tracking-wide text-mute">
        {(state.cost.inputTokens + state.cost.outputTokens).toLocaleString()} tok
        {/* costReporting=false (e.g. Copilot v1) never accumulates a real cost — say so
            instead of rendering the accumulator's initial 0 as a measured $0.00 turn. */}
        {!costReporting
          ? ' · n/a'
          : state.cost.costUsd > 0
            ? ` · $${state.cost.costUsd.toFixed(2)}`
            : ''}
      </span>
    </div>
  )
}
