import type { RelatedDefectRecord, RelatedHit } from '../../../shared/relatedHistory'
import { isOpenableUrl } from './openableUrl'

/** Everything a citation says below its header line. Both formatters below
 *  produce the SAME shape — the only thing that differs is where the fields come
 *  from — so the url gate and the optional distilled lines exist once. A second
 *  copy of this tail is exactly how one of the two would quietly stop dropping
 *  an odd-scheme url. */
interface CitationBody {
  header: string
  title: string
  status: string
  /** Untrusted, corpus-controlled: a non-http(s) url is dropped, never cited.
   *  Dropping rather than rendering it inert, because unlike the detail pane
   *  this text is headed for a model's context, where an odd-scheme string is
   *  noise at best. */
  url: string | null | undefined
  distilled: { signature: string; fix: string | null } | null
}

function formatCitation(body: CitationBody): string {
  const lines: string[] = [body.header, body.title, `Status: ${body.status}`]

  if (body.url && isOpenableUrl(body.url)) lines.push(`URL: ${body.url}`)

  if (body.distilled) {
    lines.push(`Signature: ${body.distilled.signature}`)
    if (body.distilled.fix) lines.push(`Fix: ${body.distilled.fix}`)
  }

  return `${lines.join('\n')}\n`
}

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
  let header: string
  if (hit.kind === 'corpus') {
    const source = hit.provenance[0]?.providerName ?? hit.sourceId
    header = `Related history — ${hit.key} (${source})`
  } else {
    const ref = hit.corpusRef?.key ?? hit.jiraKey
    header = `Related history — case \`${hit.caseSlug}\`${ref ? ` (${ref})` : ''}`
  }

  return formatCitation({
    header,
    title: hit.title,
    status: hit.status.label,
    url: hit.kind === 'corpus' ? hit.url : hit.corpusRef?.url,
    distilled: hit.distilled
  })
}

/**
 * The same citation for a record the user reached by FOLLOWING a link inside the
 * detail pane (spec §9's Links row), where there is no `RelatedHit` to cite: a
 * followed link is another `related.defect` call, and it returns only a
 * `RelatedDefectRecord`.
 *
 * `sourceName` is the corpus provider's display name, which the record does not
 * carry — the caller reads it off the originating hit's provenance.
 *
 * Deliberately identical in shape to {@link formatRelatedCitation}: the user
 * cannot tell from the composer whether they followed a link to get here, and
 * neither should the model.
 */
export function formatDefectRecordCitation(
  record: RelatedDefectRecord,
  sourceName: string
): string {
  return formatCitation({
    header: `Related history — ${record.key} (${sourceName})`,
    title: record.summary,
    // Composed the way the detail pane's status chip composes it, so the
    // citation reads the same as the pane the user was looking at.
    status: record.resolution ? `${record.status} / ${record.resolution}` : record.status,
    url: record.url,
    distilled: record.distilled
  })
}
