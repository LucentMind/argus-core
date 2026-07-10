import type { SettingsPayload } from '../../../../shared/settings'
import { SettingsSection } from './settingsLayout'

export function GeneralSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  void payload
  return <SettingsSection title="General">{null}</SettingsSection>
}
