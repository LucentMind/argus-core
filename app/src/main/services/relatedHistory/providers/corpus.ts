import type {
  CorpusDefectHit,
  RelatedDistilled,
  RelatedMatchedOn,
  RelatedStatusTone
} from '../../../../shared/relatedHistory'
import type { CorpusSearchHit } from '../../defectCorpus/client'
import type { DefectCorpusService } from '../../defectCorpus/service'
import type { RelatedQuery } from '../query'
import type { HistoryProvider, ProviderResult } from '../types'

export function corpusProviderId(sourceId: string): string {
  return `corpus:${sourceId}`
}

function corpusStatus(
  status: string,
  resolution: string | null
): { label: string; tone: RelatedStatusTone } {
  return {
    label: resolution ? `${status} / ${resolution}` : status,
    tone: resolution ? 'resolved' : 'open'
  }
}

function distilledFrom(hit: CorpusSearchHit): RelatedDistilled | null {
  const d = hit.record.distilled
  if (!d) return null
  // SPEC §6: `distilled` is never partial — either the whole object or null.
  return {
    signature: d.signature,
    symptoms: d.symptoms,
    rootCause: d.rootCause,
    fix: d.fix,
    terms: d.errorStrings
  }
}

/**
 * One HistoryProvider per enabled corpus source, in settings order.
 *
 * `rank` comes from array POSITION, never from `hit.score`: SPEC §5 mandates that
 * hits are returned in descending relevance order but explicitly refuses
 * cross-source score normalization, so position is the only signal that is
 * comparable against another provider's output.
 */
export function createCorpusProviders(svc: DefectCorpusService): HistoryProvider[] {
  return svc.enabledSources().map(({ id, name }) => ({
    id: corpusProviderId(id),
    name,
    kind: 'corpus' as const,
    async search(q: RelatedQuery, limit: number): Promise<ProviderResult> {
      const res = await svc.searchOne(id, undefined, { query: q.text, limit })
      if (!res.ok) return { ok: false, error: res.error ?? 'search failed', code: res.code }
      const hits: CorpusDefectHit[] = res.hits.map((hit, index) => ({
        kind: 'corpus',
        id: `${corpusProviderId(id)}:${hit.record.key}`,
        sourceId: id,
        key: hit.record.key,
        url: hit.record.url,
        provenance: [{ providerId: corpusProviderId(id), providerName: name, kind: 'corpus' }],
        title: hit.record.summary,
        snippet: hit.snippet ?? null,
        matchedOn: hit.matchedOn as RelatedMatchedOn,
        rank: index + 1,
        fusedScore: 0,
        status: corpusStatus(hit.record.status, hit.record.resolution),
        distilled: distilledFrom(hit)
      }))
      return { ok: true, hits }
    }
  }))
}
