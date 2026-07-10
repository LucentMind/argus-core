import type { SettingsPayload } from '../../../../shared/settings'
import { SettingsSection } from './settingsLayout'

export function AgentSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  void payload
  return <SettingsSection title="Agent">{null}</SettingsSection>
}
