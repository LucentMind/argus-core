import { settingsStore } from '../../lib/settingsStore'
import { SettingsSection, SettingRow, SelectField } from './settingsLayout'
import { getDriver, orderedVisibleModels, resolveDistillProvider } from '../../../../shared/drivers'
import type { SettingsPayload } from '../../../../shared/settings'

const AUTO = 'Automatic'

/**
 * Which provider instance and model run headless distillation (case close, reference sync).
 *
 * Deliberately NOT the active chat instance — see the 2026-07-19 driver-agnostic distillation
 * work. This section exists as much to SHOW the resolved default as to change it: with nothing
 * set, an install resolves to the top of its catalog, and nothing else in the app says which
 * model that is.
 *
 * Prop-driven with no effect or subscription of its own: everything is derived per render from
 * the payload plus the pure resolvers in shared/drivers.ts.
 */
export function DistillationSection({ payload }: { payload: SettingsPayload }): React.JSX.Element {
  const s = payload.settings
  const a = s.agent
  const stored = a.distillProvider
  const resolved = resolveDistillProvider(s)

  // Same gate resolveDistillProvider applies, so the UI can never offer something the
  // resolver would refuse.
  const eligible = Object.entries(a.providerInstances).filter(
    ([, i]) => i.enabled && getDriver(i.driver)?.capabilities.headlessOneShot
  )

  // Label precedence matches AgentSettings' ProviderRow rendering.
  const labelFor = (id: string): string => {
    const inst = a.providerInstances[id]
    if (!inst) return id
    const d = getDriver(inst.driver)
    return inst.displayName?.trim() || d?.shortLabel || d?.label || inst.driver
  }

  const idByLabel = new Map(eligible.map(([id]) => [labelFor(id), id]))
  const autoProvider = resolved.ok ? `${AUTO} (${labelFor(resolved.instanceId)})` : AUTO
  const autoModel = resolved.ok && resolved.model ? `${AUTO} (${resolved.model})` : AUTO

  const models = resolved.ok ? orderedVisibleModels(s, resolved.instanceId) : []

  const providerOptions = [autoProvider, ...eligible.map(([id]) => labelFor(id))]
  const providerValue = stored ? labelFor(stored.instanceId) : autoProvider

  function selectProvider(label: string): void {
    if (label === autoProvider) {
      void settingsStore.patch({ agent: { distillProvider: null } })
      return
    }
    const instanceId = idByLabel.get(label)
    if (!instanceId) return
    // `model: null` deletes the stale slug via deepMerge — but ONLY when a stored object
    // exists to recurse into. With no stored object the patch is written verbatim and a
    // literal null fails `z.string().optional()`, so the key is emitted conditionally.
    void settingsStore.patch({
      agent: { distillProvider: { instanceId, ...(stored?.model ? { model: null } : {}) } }
    })
  }

  function selectModel(model: string): void {
    if (!resolved.ok) return
    if (model === autoModel) {
      void settingsStore.patch({
        agent: { distillProvider: { instanceId: resolved.instanceId, model: null } }
      })
      return
    }
    // Choosing a model pins the instance too: a model slug is meaningless without knowing
    // which instance it belongs to.
    void settingsStore.patch({
      agent: { distillProvider: { instanceId: resolved.instanceId, model } }
    })
  }

  return (
    <SettingsSection title="Background work">
      {!resolved.ok && <div className="px-4 py-3 text-xs text-danger">{resolved.reason}</div>}
      <SettingRow
        label="Distillation provider"
        description="Runs when a case is closed and when references sync"
        isDefault={!stored}
        onReset={() => void settingsStore.patch({ agent: { distillProvider: null } })}
      >
        <SelectField
          aria-label="Distillation provider"
          value={providerValue}
          // A stored id pointing at a deleted/disabled instance is NOT in `eligible`, so it
          // must be added or React warns about a <select> value with no matching option —
          // and test output has to stay pristine.
          options={
            providerOptions.includes(providerValue)
              ? providerOptions
              : [...providerOptions, providerValue]
          }
          onChange={selectProvider}
          disabled={!resolved.ok}
        />
      </SettingRow>
      <SettingRow
        label="Distillation model"
        description="Runs unattended on every case close — a cheaper model is usually enough."
        isDefault={!stored?.model}
        onReset={() => selectModel(autoModel)}
      >
        <SelectField
          aria-label="Distillation model"
          value={stored?.model ?? autoModel}
          options={[autoModel, ...models.map((m) => m.slug)]}
          onChange={selectModel}
          disabled={!resolved.ok}
        />
      </SettingRow>
    </SettingsSection>
  )
}
