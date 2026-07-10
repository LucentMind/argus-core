import type { SettingsPayload } from '../../../../shared/settings'
import { SettingsSection } from './settingsLayout'

export function ToolsSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  void payload
  return (
    <SettingsSection title="Analysis tools">
      <div className="px-4 py-3 text-xs text-mute">sample-parse</div>
    </SettingsSection>
  )
}
