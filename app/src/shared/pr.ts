/**
 * Pull-request types shared by main and renderer. Pure — no `node:*` or Electron
 * imports (see the shared/ constraint).
 */

/** A PR bound to a case. `repoPath` is the local clone, when the case has one linked. */
export interface PrBinding {
  id: number
  caseId: number
  repoPath: string | null
  owner: string
  repo: string
  number: number
  url: string
  /**
   * How the binding came to exist. Only these two: detection is a GitHub search run
   * from inside review mode, never a Jira ticket create/refresh hook — see
   * specs/2026-07-26-github-pr-detection-design.md.
   */
  source: 'manual' | 'search'
  detectedAt: string
}

export type NewPrBinding = Omit<PrBinding, 'id' | 'caseId' | 'detectedAt'>
