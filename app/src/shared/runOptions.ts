/** The subset of the SDK's `ModelInfo` that option descriptors are derived from.
 *  Declared here rather than imported so `shared/` stays free of SDK types. */
export interface ModelOptionInfo {
  value: string
  resolvedModel?: string
  displayName: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

export interface RunOptionChoice {
  value: string
  label: string
  isDefault?: boolean
}

export type RunOptionDescriptor =
  | {
      type: 'select'
      id: string
      label: string
      options: readonly RunOptionChoice[]
      /** Values applied by prefixing the prompt rather than by a wire flag. */
      promptInjected?: readonly string[]
    }
  | { type: 'boolean'; id: string; label: string }

export type RunOptionSelection = { id: string; value: string | boolean }

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max'
}

/**
 * Build a model's option descriptors from what the CLI reports about it.
 *
 * Ultracode and Ultrathink are appended by us: neither appears in
 * `supportedEffortLevels` on any model, because neither is an effort level.
 * Ultracode is a Settings key that pairs with xhigh (hence the gate); Ultrathink
 * is prompt text.
 */
export function descriptorsFor(info: ModelOptionInfo): RunOptionDescriptor[] {
  const out: RunOptionDescriptor[] = []
  const levels = info.supportsEffort ? (info.supportedEffortLevels ?? []) : []

  if (levels.length > 0) {
    const options: RunOptionChoice[] = levels.map((v) => ({
      value: v,
      label: EFFORT_LABELS[v] ?? v,
      ...(v === 'high' ? { isDefault: true as const } : {})
    }))
    if (!options.some((o) => o.isDefault) && options.length > 0) options[0].isDefault = true
    if (levels.includes('xhigh')) options.push({ value: 'ultracode', label: 'Ultracode' })
    options.push({ value: 'ultrathink', label: 'Ultrathink' })
    out.push({
      type: 'select',
      id: 'effort',
      label: 'Reasoning',
      options,
      promptInjected: ['ultrathink']
    })

    // Measured against a live CLI: the `[1m]` slug suffix succeeds on every
    // effort-capable model and returns API 400 on Haiku, which reports no effort.
    // The catalog's alias rows are NOT the signal — only `opus` has a [1m] row,
    // yet fable and sonnet both accept the suffix.
    out.push({
      type: 'select',
      id: 'contextWindow',
      label: 'Context Window',
      options: [
        { value: '200k', label: '200k', isDefault: true },
        { value: '1m', label: '1M' }
      ]
    })
  }

  if (info.supportsFastMode) out.push({ type: 'boolean', id: 'fastMode', label: 'Fast Mode' })
  if (info.supportsAdaptiveThinking) {
    out.push({ type: 'boolean', id: 'thinking', label: 'Thinking' })
  }
  return out
}
