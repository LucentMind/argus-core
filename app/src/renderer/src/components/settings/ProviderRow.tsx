import { ArrowUpCircle } from 'lucide-react'
import { Chip } from '../ui'
import { DisclosureBtn, Switch } from './settingsLayout'
import { ProviderIcon } from './ProviderIcon'
import { RedactedText } from './RedactedText'
import type { ProviderStatus } from '../../../../shared/types'

/** `bg-review` when the provider is ready, `bg-danger` when it failed, `bg-faint` while
 *  the first probe is still outstanding. Mirrors the old single-provider header dot. */
function dotClass(state: ProviderStatus['state'] | 'disabled'): string {
  if (state === 'ready') return 'bg-review'
  if (state === 'error') return 'bg-danger'
  if (state === 'disabled') return 'bg-mute'
  return 'bg-faint'
}

/** Status line under the provider name. Mirrors the auth-line rules of the old card:
 *  an authenticated provider shows its (redactable) account, anything else its detail. */
function StatusLine({
  status,
  enabled
}: {
  status: ProviderStatus | null
  enabled: boolean
}): React.JSX.Element | null {
  if (!enabled) return <span className="text-xs text-mute">Disabled</span>
  if (!status) return <span className="text-xs text-mute">Checking provider status</span>
  if (status.state === 'ready' && status.email) {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-mute">
        <span>Authenticated as</span>
        <RedactedText value={status.email} aria-label="Toggle account email visibility" />
        {status.subscription && <span>· {status.subscription}</span>}
      </span>
    )
  }
  return (
    <span className={`text-xs ${status.state === 'error' ? 'text-danger' : 'text-mute'}`}>
      {status.detail}
      {status.state === 'error' && status.fixHint && (
        <span className="block text-mute">{status.fixHint}</span>
      )}
    </span>
  )
}

/**
 * One provider in the settings list: status dot, vendor glyph, name, version, an update
 * advisory when the CLI is behind, an enable/disable toggle, and a chevron revealing its
 * config. Replaces the old two-section layout (a chip rail that only *selected* an
 * instance, plus a separate card showing the selected one) — every provider's real state
 * is visible at once now that several can be enabled together.
 */
export function ProviderRow({
  instanceId,
  driverKind,
  label,
  status,
  enabled,
  expanded,
  isDefault,
  canSetDefault,
  onToggleEnabled,
  onToggleExpanded,
  onSetDefault,
  children
}: {
  instanceId: string
  driverKind: string
  label: string
  status: ProviderStatus | null
  enabled: boolean
  expanded: boolean
  isDefault: boolean
  canSetDefault: boolean
  onToggleEnabled: (v: boolean) => void
  onToggleExpanded: () => void
  onSetDefault: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const behind = status?.latestVersion
  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-3">
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${dotClass(enabled ? (status?.state ?? 'checking') : 'disabled')}`}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <ProviderIcon kind={driverKind} className="shrink-0 text-ink" />
            <span
              data-testid={`provider-label-${instanceId}`}
              className="truncate text-sm text-ink"
            >
              {label}
            </span>
            {status?.version && (
              <span className="font-mono text-xs text-mute">v{status.version}</span>
            )}
            {behind && (
              <span
                className="flex items-center gap-1 text-xs text-review"
                title={
                  status?.updateCommand
                    ? `Update available (v${behind}) — run: ${status.updateCommand}`
                    : `Update available (v${behind})`
                }
              >
                <ArrowUpCircle size={13} strokeWidth={1.5} aria-hidden />
                <Chip tone="review">v{behind}</Chip>
              </span>
            )}
            {isDefault && (
              <span data-testid={`provider-default-${instanceId}`} className="shrink-0">
                <Chip
                  tone="signal"
                  title="Used for new chats and background work (distillation, reference sync)"
                >
                  Default
                </Chip>
              </span>
            )}
            {canSetDefault && (
              <button
                type="button"
                onClick={onSetDefault}
                aria-label={`Set ${label} as default provider`}
                className="shrink-0 text-xs text-defect hover:text-defect/70"
              >
                Set as default
              </button>
            )}
          </span>
          <StatusLine status={status} enabled={enabled} />
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <DisclosureBtn
            expanded={expanded}
            onToggle={onToggleExpanded}
            label={`${label} settings`}
          />
          <Switch checked={enabled} onChange={onToggleEnabled} aria-label={`Enable ${label}`} />
        </span>
      </div>
      {expanded && children}
    </div>
  )
}
