import { ConfluenceSpaces } from './ConfluenceSpaces'
import { PacksSettings } from './PacksSettings'
import type { SettingsPayload } from '../../../../shared/settings'

/** Sources (spec §3.1): where library content comes from — installed packs + Confluence reference sync. */
export function SourcesPage({ settings }: { settings: SettingsPayload }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <PacksSettings settings={settings} />
      <ConfluenceSpaces />
    </div>
  )
}
