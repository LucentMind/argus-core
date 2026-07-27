import type { PromptTextSpecs } from './promptSpec'

/**
 * Prompts the onboarding tour stages into the composer on the user's behalf. Model-facing, so
 * they are registered — but the renderer owns the tour, so the text lives here where both
 * sides can read it: main's registry uses it as the entry default, and `TourCompanion` uses it
 * as the fallback when the dev-tools gate is off and the resolve IPC refuses.
 */
export const TOUR_PROMPTS: PromptTextSpecs = {
  'tour.memory': {
    title: 'Onboarding tour — memory & skills prompt',
    text: 'We keep seeing bearing-discontinuity errors in nav.fusion after an IMU bearing-drift warning. Remember this pattern for future cases, and draft a reusable skill that flags it so I can review and add it to my library.'
  }
}
