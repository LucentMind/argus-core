import { settingsStore } from '../../lib/settingsStore'
import { SettingsSection, SettingRow, SelectField, DraftInput, FIELD } from './settingsLayout'
import { RcaTemplateSettings } from './RcaTemplateSettings'
import type { SettingsPayload } from '../../../../shared/settings'

/** Labels for `settings.rca.techDestination` — display strings for exactly this one
 *  SelectField, whose contract is label-in/label-out (see settingsLayout.tsx), so they live
 *  beside it rather than in shared/settings.ts. */
const TECH_DESTINATION_LABELS = {
  attachment: 'Attach markdown to the Jira issue',
  'confluence-page': 'Publish a Confluence page'
} as const
const TECH_DESTINATION_BY_LABEL: Record<string, keyof typeof TECH_DESTINATION_LABELS> =
  Object.fromEntries(Object.entries(TECH_DESTINATION_LABELS).map(([k, v]) => [v, k])) as Record<
    string,
    keyof typeof TECH_DESTINATION_LABELS
  >

/**
 * What a confirmed RCA writes and where it is posted.
 *
 * Lives on the Agent page (user-directed, 2026-08-21), not Connectors. Only the destination row
 * is about a connector; the template is a standing instruction to the model — the same kind of
 * setting as the persona append and the distillation guidance it now sits below.
 */
export function RcaReportSettings({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const rca = payload.settings.rca

  return (
    <SettingsSection title="RCA report" subtitle="What a confirmed RCA writes, and where it goes.">
      <SettingRow
        label="Technical report destination"
        description="Where a confirmed RCA's technical drill-down is posted — the exec summary always goes as a Jira comment."
        isDefault={rca.techDestination === 'attachment'}
        onReset={() => void settingsStore.patch({ rca: { techDestination: null } })}
      >
        <SelectField
          aria-label="Technical report destination"
          value={TECH_DESTINATION_LABELS[rca.techDestination]}
          options={Object.values(TECH_DESTINATION_LABELS)}
          onChange={(v) =>
            void settingsStore.patch({ rca: { techDestination: TECH_DESTINATION_BY_LABEL[v] } })
          }
        />
      </SettingRow>
      {rca.techDestination === 'confluence-page' && (
        <SettingRow
          label="Confluence space key"
          description='The space the technical report is published into, e.g. "ENG".'
          isDefault={!rca.confluenceSpaceKey}
          onReset={() => void settingsStore.patch({ rca: { confluenceSpaceKey: null } })}
        >
          <DraftInput
            value={rca.confluenceSpaceKey}
            onCommit={(v) => void settingsStore.patch({ rca: { confluenceSpaceKey: v.trim() } })}
            aria-label="Confluence space key"
            className={FIELD}
            placeholder="ENG"
          />
        </SettingRow>
      )}
      {/* Outside the confluence-page branch above: the template drives BOTH reports and must
          stay reachable whatever the tech destination is. */}
      <RcaTemplateSettings template={rca.template} />
    </SettingsSection>
  )
}
