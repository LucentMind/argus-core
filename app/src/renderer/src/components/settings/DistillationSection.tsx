import { useEffect, useState } from 'react'
import { settingsStore } from '../../lib/settingsStore'
import { Chip } from '../ui'
import { SettingsSection, SettingRow, SelectField, DraftTextarea } from './settingsLayout'
import {
  getDriver,
  orderedVisibleModels,
  resolveDistillProvider,
  resolveDistillAgentProvider
} from '../../../../shared/drivers'
import type { SettingsPayload } from '../../../../shared/settings'
import type { DistillationUsageStats } from '../../../../shared/observability'

const AUTO = 'Automatic'

/** avg cost/turns/prompt-size readout for the usage row — each segment omitted when its average
 *  is null (no done run ever recorded that column; SQL AVG ignores NULLs, so this never
 *  fabricates a $0.00/0-turn average from rows that simply predate usage tracking). Moved here
 *  from MemorySettings with the row it describes (user-directed, 2026-08-21). */
function distillationDescription(d: DistillationUsageStats): string {
  const parts: string[] = []
  if (d.avgCostUsd !== null) parts.push(`avg $${d.avgCostUsd.toFixed(2)}`)
  if (d.avgTurnCount !== null) parts.push(`avg ${d.avgTurnCount.toFixed(1)} turns`)
  if (d.avgPromptChars !== null) parts.push(`avg ${Math.round(d.avgPromptChars)} prompt chars`)
  return parts.length > 0 ? parts.join(' · ') : 'no usage recorded on these runs'
}

type DistillPipeline = SettingsPayload['settings']['distill']['pipeline']
/** Display labels for `settings.distill.pipeline`; the select round-trips through these. */
const PIPELINE_LABELS: Record<DistillPipeline, string> = {
  v2: 'Single call (v2)',
  v3: 'Staged pipeline (v3)'
}
const PIPELINE_OPTIONS = Object.values(PIPELINE_LABELS)

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
  /**
   * What distillation has actually cost. Lived on the Memory page until 2026-08-21, where it
   * reported on jobs configured two pages away; the spend belongs beside the provider and model
   * that decide it.
   *
   * Fetched here rather than passed down: `usage.stats()` is a whole-app payload with no other
   * consumer on this page, and the section is otherwise prop-derived. A failed call leaves the
   * row absent — a settings page must not surface a stats outage as an error.
   */
  const [distillUsage, setDistillUsage] = useState<DistillationUsageStats | null>(null)
  useEffect(() => {
    let alive = true
    void window.argus.usage
      .stats()
      .then((u) => {
        if (alive) setDistillUsage(u.distillation)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const s = payload.settings
  const a = s.agent
  const stored = a.distillProvider
  const resolved = resolveDistillProvider(s)
  // Agent-based distillation (the v2 world-model builder) needs a native-tool-capable driver
  // — a strict SUBSET of what one-shot distillation (refSync, the reject digest) accepts. When
  // the resolved one-shot provider can't also serve the agent path, the case-close distiller
  // silently falls back to reference-sync-only behavior elsewhere; this row is what tells the
  // operator why, instead of leaving them to infer it from a job outcome.
  const agentResolved = resolveDistillAgentProvider(s)

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
    <SettingsSection
      title="Background work"
      subtitle="Unattended runs: which provider does them, and what they have cost."
    >
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
      {resolved.ok && !agentResolved.ok && (
        <div className="px-4 pb-3 text-xs text-danger">
          Agent-based distillation requires a provider with agent support (currently Claude). This
          provider can only run reference sync.
        </div>
      )}
      <SettingRow
        label="Distillation pipeline"
        description="Single call = one agentic prompt (v2). Staged = dossier → summary ‖ candidates → materialize, with per-stage records (v3)."
        isDefault={s.distill.pipeline === 'v2'}
        onReset={() => void settingsStore.patch({ distill: { pipeline: null } })}
      >
        <SelectField
          aria-label="Distillation pipeline"
          value={PIPELINE_LABELS[s.distill.pipeline]}
          options={PIPELINE_OPTIONS}
          onChange={(label) => {
            const next = (Object.keys(PIPELINE_LABELS) as DistillPipeline[]).find(
              (k) => PIPELINE_LABELS[k] === label
            )
            if (next && next !== s.distill.pipeline)
              void settingsStore.patch({ distill: { pipeline: next } })
          }}
        />
      </SettingRow>
      <SettingRow
        label="Distillation guidance"
        description="Folded into every case distillation's prompt, under an Operator guidance header"
        isDefault={s.distill.guidance === ''}
        onReset={() => void settingsStore.patch({ distill: { guidance: null } })}
      >
        <DraftTextarea
          aria-label="Distillation guidance"
          placeholder='Standing instructions for the distiller — e.g. "never propose skills about internal tooling"'
          className="w-72 rounded-r2 border border-hair bg-well p-2 font-mono text-xs text-ink placeholder:text-mute focus:border-hair2 focus:outline-none"
          value={s.distill.guidance}
          onCommit={(v) => void settingsStore.patch({ distill: { guidance: v || null } })}
        />
      </SettingRow>
      {distillUsage && distillUsage.jobCount > 0 && (
        <SettingRow
          label={`${distillUsage.jobCount} completed run${distillUsage.jobCount === 1 ? '' : 's'}`}
          description={distillationDescription(distillUsage)}
        >
          {distillUsage.totalCostUsd !== null && (
            <Chip tone="neutral">${distillUsage.totalCostUsd.toFixed(2)} total</Chip>
          )}
          {/* Failed capHit runs ran the whole agent loop before refusing to parse — often the
              most expensive outcome, not a free one — so their spend gets its own chip rather
              than vanishing into a done-only total. */}
          {distillUsage.failedCostUsd !== null && distillUsage.failedCostUsd > 0 && (
            <Chip tone="danger">+${distillUsage.failedCostUsd.toFixed(2)} on failed runs</Chip>
          )}
        </SettingRow>
      )}
    </SettingsSection>
  )
}
