import { useEffect, useState } from 'react'
import type { SourceControlStatus } from '../../../../shared/sourcecontrol'
import { SettingsSection } from './settingsLayout'

const GITHUB_PATH =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z'

type DotState = 'ok' | 'fail' | 'off'

/** Matches AgentSettings' statusDotClass convention: faint while unknown/off, review/danger once resolved. */
function dotClass(state: DotState): string {
  if (state === 'ok') return 'bg-review'
  if (state === 'fail') return 'bg-danger'
  return 'bg-faint'
}

export function SourceControl(): React.JSX.Element {
  const [status, setStatus] = useState<SourceControlStatus | null>(null)
  useEffect(() => {
    let mounted = true
    void window.argus.sourceControl
      .status()
      .then((s: SourceControlStatus) => {
        if (mounted) setStatus(s)
      })
      .catch(() => {
        if (mounted)
          setStatus({
            installed: false,
            version: null,
            authenticated: false,
            login: null,
            detail: 'status unavailable'
          })
      })
    return () => {
      mounted = false
    }
  }, [])
  const dotState: DotState = !status
    ? 'off'
    : !status.installed
      ? 'off'
      : status.authenticated
        ? 'ok'
        : 'fail'
  return (
    <SettingsSection title="Source control">
      <div className="flex items-center gap-3 px-3 py-2">
        <span
          data-testid="sc-dot-github"
          data-state={dotState}
          className={`h-2 w-2 shrink-0 rounded-full ${dotClass(dotState)}`}
        />
        <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current text-ink" aria-hidden="true">
          <path d={GITHUB_PATH} />
        </svg>
        <span className="font-medium text-ink">GitHub</span>
        {status ? (
          <>
            {status.version && <span className="font-mono text-xs text-dim">{status.version}</span>}
            <span className="text-sm text-dim">
              {status.authenticated
                ? `Authenticated as ${status.login}`
                : status.installed
                  ? `${status.detail} — run \`gh auth login\``
                  : status.detail}
            </span>
          </>
        ) : (
          <span className="text-sm text-dim">checking…</span>
        )}
      </div>
    </SettingsSection>
  )
}
