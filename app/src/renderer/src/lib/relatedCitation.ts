import type { RelatedHit } from '../../../shared/relatedHistory'
import { isOpenableUrl } from './openableUrl'

/**
 * A compact citation for one related-history hit, staged into the composer for
 * the user to read, edit and send (spec §10).
 *
 * Built from the hit ALREADY IN HAND — no `related.defect` fetch — so it costs
 * no round-trip and still works while the corpus is unreachable.
 *
 * This is the one path from corpus text to the model, and it is deliberately a
 * DRAFT (spec §12.4): the caller stages it through `composerDraft`, never as a
 * turn. Keep it short for the same reason — the user has to be able to read the
 * whole thing before sending it.
 */
export function formatRelatedCitation(hit: RelatedHit): string {
  const lines: string[] = []

  if (hit.kind === 'corpus') {
    const source = hit.provenance[0]?.providerName ?? hit.sourceId
    lines.push(`Related history — ${hit.key} (${source})`)
  } else {
    const ref = hit.corpusRef?.key ?? hit.jiraKey
    lines.push(`Related history — case \`${hit.caseSlug}\`${ref ? ` (${ref})` : ''}`)
  }

  lines.push(hit.title)
  lines.push(`Status: ${hit.status.label}`)

  // Untrusted, corpus-controlled: a non-http(s) url is dropped, never cited.
  // Dropping rather than rendering it inert, because unlike the detail pane
  // this text is headed for a model's context, where an odd-scheme string is
  // noise at best.
  const url = hit.kind === 'corpus' ? hit.url : hit.corpusRef?.url
  if (url && isOpenableUrl(url)) lines.push(`URL: ${url}`)

  if (hit.distilled) {
    lines.push(`Signature: ${hit.distilled.signature}`)
    if (hit.distilled.fix) lines.push(`Fix: ${hit.distilled.fix}`)
  }

  return `${lines.join('\n')}\n`
}
