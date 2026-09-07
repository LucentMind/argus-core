import type { CaseRecord } from '../../../shared/types'

/**
 * What a case is CALLED on screen, as opposed to what it is keyed by.
 *
 * `slug` is minted from the ticket key when the case is created and is then the identifier for
 * everything durable — the case directory, evidence rows, bundles, session records, distill
 * jobs — so it cannot follow a ticket that moves project (CORESDK-4917 → NN-5401) without a
 * migration. `jira_key` DOES follow it: `JiraCases.refresh` detects the transfer (`rebound`)
 * and rewrites the binding. So the live key is the honest label and the slug is the honest id,
 * and the two stop agreeing exactly when a ticket moves.
 *
 * Every surface that shows a case's identity to a human uses this; nothing that addresses a
 * case does. Pair it with `caseLabelTitle` so the slug stays reachable on hover.
 */
export function caseLabel(kase: Pick<CaseRecord, 'slug' | 'jiraKey'> | null | undefined): string {
  return kase?.jiraKey ?? kase?.slug ?? ''
}

/** Tooltip for a label that is not the slug: names the id the label is standing in for. */
export function caseLabelTitle(
  kase: Pick<CaseRecord, 'slug' | 'jiraKey'> | null | undefined
): string | undefined {
  if (!kase) return undefined
  return kase.jiraKey && kase.jiraKey !== kase.slug ? `Case ${kase.slug}` : undefined
}
