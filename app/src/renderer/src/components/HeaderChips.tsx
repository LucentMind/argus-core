import { useEffect, useState, useSyncExternalStore } from 'react'
import { Chip } from './ui'
import { agentStore, EMPTY_CASE_AGENT_STATE } from '../lib/agentStore'
import { useSettingsPayload } from '../lib/settingsStore'
import { activeCapabilities } from '../../../shared/drivers'
import type { AuthStatus, PreflightReport } from '../../../shared/types'

export function HeaderChips({
  slug,
  sessionId
}: {
  slug: string
  sessionId: number | null
}): React.JSX.Element {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [preflight, setPreflight] = useState<PreflightReport | null>(null)
  const state = useSyncExternalStore(
    (cb) => agentStore.subscribe(cb),
    () => (sessionId === null ? EMPTY_CASE_AGENT_STATE : agentStore.get(slug, sessionId))
  )
  const settingsPayload = useSettingsPayload()
  const costReporting = activeCapabilities(settingsPayload?.settings).costReporting

  useEffect(() => {
    // authStatus() can be in flight when agent:auth-changed fires (e.g. a turn 401s
    // right after mount). Without a sequence guard, the stale mount-time probe can
    // resolve AFTER the refresh triggered by the broadcast and overwrite the correct
    // (red) state back to green — a last-write-wins hazard, not just an unmount race.
    let seq = 0
    const refresh = (): void => {
      const mySeq = ++seq
      void window.argus.agent.authStatus().then((status) => {
        if (mySeq === seq) setAuth(status)
      })
    }
    refresh()
    void window.argus.agent.preflight().then(setPreflight)
    // The verdict changes from turn evidence (spec §5), not just at mount — a chip that
    // only ever probed once was the whole reason a logged-out app kept showing ✓.
    const unsubscribe = window.argus.agent.onAuthChanged(refresh)
    return () => {
      // Invalidate any still-in-flight probe so a response arriving after unmount
      // (or during teardown) can never call setState.
      seq = -1
      unsubscribe()
    }
  }, [])

  const authLabel = !auth
    ? 'claude …'
    : !auth.ok
      ? 'claude ✗'
      : auth.verified
        ? 'claude ✓'
        : 'claude ~'
  const authTone = !auth ? 'neutral' : !auth.ok ? 'danger' : auth.verified ? 'review' : 'neutral'
  const authTitle = !auth
    ? 'probing claude CLI…'
    : auth.ok && !auth.verified
      ? `${auth.detail} — sign-in confirmed on your first message`
      : auth.detail

  return (
    <div className="flex items-center gap-2">
      <span title={authTitle}>
        <Chip tone={authTone}>{authLabel}</Chip>
      </span>
      <span
        title={
          preflight
            ? preflight.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n')
            : 'running preflight…'
        }
      >
        <Chip tone={preflight?.ok ? 'review' : 'neutral'}>
          {preflight ? (preflight.ok ? 'tools ✓' : 'tools ✗') : 'tools …'}
        </Chip>
      </span>
      <Chip tone="neutral">
        {(state.cost.inputTokens + state.cost.outputTokens).toLocaleString()} tok
        {/* costReporting=false (e.g. Copilot v1) never accumulates a real cost —
            say so honestly instead of rendering the accumulator's initial 0 as
            if it were a measured $0.00 turn. */}
        {!costReporting
          ? ' · n/a'
          : state.cost.costUsd > 0
            ? ` · $${state.cost.costUsd.toFixed(2)}`
            : ''}
      </Chip>
    </div>
  )
}
