import { resolveDistillProvider } from '../../../../shared/drivers'
import { useSettingsPayload } from '../../lib/settingsStore'
import type { AppSettings } from '../../../../shared/settings'

export type AssistProvider = { ok: true; text: string } | { ok: false; reason: string }

/**
 * Which provider Draft/Improve will actually run on, as display text.
 *
 * The assist goes through `createHeadlessRunner`, which resolves the *distillation*
 * provider — never the active chat instance. So the model here is not the one in the chat
 * switcher, and users had no way to tell. `resolveDistillProvider` is the same function the
 * main process calls, so this label cannot drift from what really runs, and its failure
 * `reason` is reused verbatim rather than paraphrased.
 */
export function assistProviderLabel(settings: AppSettings): AssistProvider {
  const r = resolveDistillProvider(settings)
  if (!r.ok) return { ok: false, reason: r.reason }
  // `model` is optional at every fallback in `distillOk` — render the driver alone rather
  // than "· undefined".
  return { ok: true, text: r.model ? `via ${r.driverKind} · ${r.model}` : `via ${r.driverKind}` }
}

/** `null` only while settings have not loaded; callers leave the assist enabled until then. */
export function useAssistProvider(): AssistProvider | null {
  const payload = useSettingsPayload()
  return payload ? assistProviderLabel(payload.settings) : null
}
