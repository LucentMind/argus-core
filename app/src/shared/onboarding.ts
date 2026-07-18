// Shared, import-safe constants for onboarding (no electron/node imports).
export const SAMPLE_CASE_SLUG = 'sample-onboarding'
export const SAMPLE_CASE_TITLE = 'Sample: guided tour case'

/** Filenames under resources/onboarding-sample/ ingested as the sample case's evidence. */
export const SAMPLE_EVIDENCE_FILES = ['sample-log.txt'] as const

// Pack is LAST and non-gating: the final step lets the user finish setup or
// install a domain pack. Seeding happens just before it (and gates advancing to
// the final step), so we never finish onboarding on a failed seed.
export const WIZARD_STEPS = ['welcome', 'provider', 'integrations', 'seed', 'pack'] as const
export type WizardStepId = (typeof WIZARD_STEPS)[number]

export interface SeedSampleResult {
  slug: string
  evidenceIds: number[]
}
