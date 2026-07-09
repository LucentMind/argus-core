import { useEffect, useState, useSyncExternalStore } from 'react'
import { Chip } from './ui'
import { agentStore } from '../lib/agentStore'
import type { AuthStatus, PreflightReport } from '../../../shared/types'

export function HeaderChips({ slug }: { slug: string }): React.JSX.Element {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [preflight, setPreflight] = useState<PreflightReport | null>(null)
  const state = useSyncExternalStore(
    (cb) => agentStore.subscribe(cb),
    () => agentStore.get(slug)
  )

  useEffect(() => {
    void window.argus.agent.authStatus().then(setAuth)
    void window.argus.agent.preflight().then(setPreflight)
  }, [])

  return (
    <div className="flex items-center gap-2">
      <span title={auth?.detail ?? 'probing claude CLI…'}>
        <Chip tone={auth?.ok ? 'review' : 'danger'}>
          {auth ? (auth.ok ? 'claude ✓' : 'claude ✗') : 'claude …'}
        </Chip>
      </span>
      <span
        title={
          preflight
            ? preflight.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n')
            : 'running preflight…'
        }
      >
        <Chip tone={preflight?.ok ? 'review' : 'neutral'}>
          {preflight ? (preflight.ok ? 'trace ✓' : 'trace ✗') : 'trace …'}
        </Chip>
      </span>
      <Chip tone="neutral">
        {(state.cost.inputTokens + state.cost.outputTokens).toLocaleString()} tok
        {state.cost.costUsd > 0 ? ` · $${state.cost.costUsd.toFixed(2)}` : ''}
      </Chip>
    </div>
  )
}
