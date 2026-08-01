import {
  apiModelId,
  claudeSettingsFor,
  descriptorsFor,
  effectiveEffort,
  type ModelOptionInfo,
  type RunOptionSelection
} from '../../../../../shared/runOptions'
import type { PermissionMode } from '../../../../../shared/settings'

export interface RunOptionQueryFields {
  model?: string
  effort?: string
  settings?: { ultracode?: true; fastMode?: true; alwaysThinkingEnabled?: boolean }
  permissionMode?: PermissionMode
  allowDangerouslySkipPermissions?: true
}

/**
 * The raw stored value for one descriptor id, undefined when nothing was ever selected.
 * Deliberately NOT defaulted the way `selectionValue` (shared/runOptions.ts) is: that
 * default-substitution is right for rendering a chip's current label, but wrong here —
 * substituting the descriptor's default (e.g. effort 'high') would make "no selections"
 * send an explicit wire value instead of nothing, re-asserting a default the SDK would
 * already apply on its own.
 */
function rawSelection(
  id: string,
  runOptions: readonly RunOptionSelection[]
): string | boolean | undefined {
  return runOptions.find((s) => s.id === id)?.value
}

/**
 * Translate this session's option selections into the exact fields the SDK's
 * `query()` takes. Selections are resolved against the model's own descriptors,
 * so anything the model does not support is dropped rather than sent.
 */
export function buildRunOptionQueryFields(
  info: ModelOptionInfo | null,
  model: string | undefined,
  runOptions: readonly RunOptionSelection[],
  permissionMode: PermissionMode
): RunOptionQueryFields {
  const ds = info ? descriptorsFor(info) : []
  const effortDescriptor = ds.find((d) => d.id === 'effort')
  const ctxDescriptor = ds.find((d) => d.id === 'contextWindow')

  const effort = effectiveEffort(
    effortDescriptor,
    effortDescriptor ? rawSelection('effort', runOptions) : undefined
  )
  const settings = claudeSettingsFor(ds, runOptions)
  const ctx = ctxDescriptor ? rawSelection('contextWindow', runOptions) : undefined

  return {
    ...(model ? { model: apiModelId(model, ctx) } : {}),
    ...(effort ? { effort } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...(permissionMode !== 'default' ? { permissionMode } : {}),
    // sdk.d.ts:1695 — bypassPermissions is inert without this. It was missing before,
    // which is why the previously-cosmetic chip never surfaced the problem.
    ...(permissionMode === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true as const }
      : {})
  }
}
