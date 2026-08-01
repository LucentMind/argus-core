import { PacksSettings } from './PacksSettings'
import type { SettingsPayload } from '../../../../shared/settings'

/**
 * Sources (spec §3.1): where library content comes from.
 *
 * Confluence sync moved to Team (2026-08-01, user-directed) — it is a shared upstream a
 * workspace subscribes to and keeps current, which is the same relationship the HiveMind repo
 * has, so the two now sit side by side there. What is left here is pack installation.
 */
export function SourcesPage({ settings }: { settings: SettingsPayload }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <PacksSettings settings={settings} />
    </div>
  )
}
