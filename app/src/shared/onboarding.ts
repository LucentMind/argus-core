// Shared, import-safe constants for onboarding (no electron/node imports).
export const SAMPLE_CASE_SLUG = 'sample-onboarding'
export const SAMPLE_CASE_TITLE = 'Sample: guided tour case'

/** Filenames under resources/onboarding-sample/ ingested as the sample case's evidence. */
export const SAMPLE_EVIDENCE_FILES = ['sample-log.txt'] as const

export const WIZARD_STEPS = ['welcome', 'claude', 'pack', 'integrations', 'seed'] as const
export type WizardStepId = (typeof WIZARD_STEPS)[number]

export interface SeedSampleResult {
  slug: string
  evidenceIds: number[]
}
