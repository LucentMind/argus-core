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
  const baseLabel = (id: string): string => {
    const inst = a.providerInstances[id]
    if (!inst) return id
    const d = getDriver(inst.driver)
    return inst.displayName?.trim() || d?.shortLabel || d?.label || inst.driver
  }

  // Two un-renamed instances of the same driver share a base label (two Claude accounts is
  // the documented motivating case for multi-provider). Options are keyed BY LABEL here, so
  // a collision would silently pin the wrong instance and duplicate a React key — qualify
  // the label with the instance id whenever the base repeats.
  const baseCounts = new Map<string, number>()
  for (const [id] of eligible) {
    const b = baseLabel(id)
    baseCounts.set(b, (baseCounts.get(b) ?? 0) + 1)
  }
  const labelFor = (id: string): string => {
    const b = baseLabel(id)
    return (baseCounts.get(b) ?? 0) > 1 ? `${b} (${id})` : b
  }

  const idByLabel = new Map(eligible.map(([id]) => [labelFor(id), id]))
  const autoProvider = resolved.ok ? `${AUTO} (${labelFor(resolved.instanceId)})` : AUTO
  const autoModel = resolved.ok && resolved.model ? `${AUTO} (${resolved.model})` : AUTO

  const models = resolved.ok ? orderedVisibleModels(s, resolved.instanceId) : []

  const providerOptions = [autoProvider, ...eligible.map(([id]) => labelFor(id))]
  const providerValue = stored ? labelFor(stored.instanceId) : autoProvider
  const modelValue = stored?.model ?? autoModel
  const modelOptions = [autoModel, ...models.map((m) => m.slug)]

  /** A value with no matching <option> makes React warn AND renders as something else —
   *  which for this section would mean displaying a model the runtime is not using. Both
   *  selects therefore append an unmatched value rather than silently misreporting it. */
  const withValue = (options: string[], value: string): string[] =>
    options.includes(value) ? options : [...options, value]

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
      // Unconditional `model: null` is safe here only because this path is reachable solely
      // when a model IS stored — SettingRow renders its reset only when `!isDefault`, and
      // Automatic is not otherwise selectable once it is the current value. A stored object
      // therefore always exists for deepMerge to recurse into and delete the key from.
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
          options={withValue(providerOptions, providerValue)}
          onChange={selectProvider}
          // Gated on eligibility, NOT on `resolved.ok`. The two differ: the resolver's
          // FALLBACK is claude-agent-sdk-only, so a Copilot-only install resolves `ok:false`
          // while still having a perfectly selectable capable instance. Disabling on
          // `resolved.ok` there would strand the user with an error above a dropdown they
          // cannot use — the exact hand-edit-the-json state this section exists to remove.
          disabled={eligible.length === 0}
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
          value={modelValue}
          // A pinned model that was later HIDDEN in the Models section drops out of
          // orderedVisibleModels, but resolveDistillProvider passes an explicit model through
          // without a visibility check — so the runtime still uses it. It must stay listed, or
          // this row would claim Automatic while distillation ran on the pinned model.
          options={withValue(modelOptions, modelValue)}
          onChange={selectModel}
          disabled={!resolved.ok}
        />
      </SettingRow>
    </SettingsSection>
  )
}
