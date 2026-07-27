import type { PromptCaptureDetail, SessionPromptCapture } from '../../../shared/promptsIpc'

/**
 * Pair a stored capture with the persona a NEW session in its mode would build right now.
 *
 * `persona` is injected rather than imported so this stays free of `buildPromptPreview`'s live
 * inputs (packs, settings, resolved skills) and testable without them.
 */
export function buildCaptureDetail(input: {
  capture: SessionPromptCapture
  persona: () => string
}): PromptCaptureDetail {
  let currentPersona = ''
  try {
    currentPersona = input.persona()
  } catch {
    // A mode retired since the capture was written. "Cannot compare" must never render as
    // "unchanged" — that would hide exactly the drift this page exists to surface.
    currentPersona = ''
  }
  return {
    capture: input.capture,
    // The `!== ''` guard is load-bearing: every string startsWith('') is true, so without it an
    // uncomputable persona would report a match. `currentPersona` itself is not shipped — the
    // Composed preview tab already renders that exact text, so shipping it again on every open
    // would just be a second, redundant multi-KB payload.
    personaMatchesCurrent:
      currentPersona !== '' && input.capture.systemAppend.startsWith(currentPersona)
  }
}
