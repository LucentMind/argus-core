import { describe, it, expect } from 'vitest'
import { formatRelatedCitation } from '../relatedCitation'
import type { CorpusDefectHit, LocalCaseHit } from '../../../../shared/relatedHistory'

const corpusHit = (over: Partial<CorpusDefectHit> = {}): CorpusDefectHit => ({
  kind: 'corpus',
  id: 'corpus:src1:KAN-5',
  sourceId: 'src1',
  key: 'KAN-5',
  url: 'https://corpus.example/browse/KAN-5',
  provenance: [{ providerId: 'corpus:src1', providerName: 'Hindsight', kind: 'corpus' }],
  title: 'charge plan dropped',
  snippet: null,
  matchedOn: 'lexical',
  rank: 1,
  fusedScore: 0.016,
  status: { label: 'Done / Fixed', tone: 'resolved' },
  distilled: {
    signature: 'charge plan dropped after reset',
    symptoms: 'plan is null',
    rootCause: 'cache cleared before reload',
    fix: 'reload before clearing',
    terms: ['E_PLAN_NULL']
  },
  ...over
})

const localHit = (over: Partial<LocalCaseHit> = {}): LocalCaseHit => ({
  kind: 'local',
  id: 'local:old-case',
  caseSlug: 'old-case',
  jiraKey: 'NAV-9',
  provenance: [{ providerId: 'local', providerName: 'Your cases', kind: 'local' }],
  title: 'ECU reset drifts DLT',
  snippet: null,
  matchedOn: 'lexical',
  rank: 1,
  fusedScore: 0.016,
  status: { label: 'solved', tone: 'resolved' },
  distilled: {
    signature: 'ECU reset drifts DLT',
    symptoms: 'timestamps jump',
    rootCause: 'clock resync races the first log write',
    fix: 'ignore the first two seconds after reset',
    terms: ['E_DLT_DRIFT']
  },
  ...over
})

describe('formatRelatedCitation', () => {
  it('cites a corpus hit with key, title, url, signature and fix', () => {
    const text = formatRelatedCitation(corpusHit())
    expect(text).toContain('Related history — KAN-5 (Hindsight)')
    expect(text).toContain('charge plan dropped')
    expect(text).toContain('https://corpus.example/browse/KAN-5')
    expect(text).toContain('Signature: charge plan dropped after reset')
    expect(text).toContain('Fix: reload before clearing')
    expect(text).toContain('Status: Done / Fixed')
  })

  it('omits a non-http(s) url rather than citing it', () => {
    const text = formatRelatedCitation(corpusHit({ url: 'javascript:alert(1)' }))
    expect(text).not.toContain('javascript:')
    expect(text).not.toContain('URL:')
  })

  it('cites a local hit by case slug, with no url line', () => {
    const text = formatRelatedCitation(localHit())
    expect(text).toContain('Related history — case `old-case` (NAV-9)')
    expect(text).toContain('Signature: ECU reset drifts DLT')
    expect(text).toContain('Fix: ignore the first two seconds after reset')
    expect(text).not.toContain('URL:')
  })

  it('cites a merged row by its case and its corpus key', () => {
    const text = formatRelatedCitation(
      localHit({
        jiraKey: 'NAV-9',
        corpusRef: {
          sourceId: 'src1',
          key: 'KAN-5',
          url: 'https://corpus.example/browse/KAN-5'
        }
      })
    )
    expect(text).toContain('case `old-case`')
    expect(text).toContain('KAN-5')
    expect(text).not.toContain('NAV-9')
    expect(text).toContain('https://corpus.example/browse/KAN-5')
  })

  it('falls back to the hit title when there is no distilled block', () => {
    const text = formatRelatedCitation(corpusHit({ distilled: null }))
    expect(text).toContain('charge plan dropped')
    expect(text).not.toContain('Signature:')
    expect(text).not.toContain('Fix:')
  })

  it('emits signature but omits fix when distilled.fix is null', () => {
    const text = formatRelatedCitation(
      corpusHit({
        distilled: {
          signature: 'charge plan dropped after reset',
          symptoms: 'plan is null',
          rootCause: 'cache cleared before reload',
          fix: null,
          terms: ['E_PLAN_NULL']
        }
      })
    )
    expect(text).toContain('Signature: charge plan dropped after reset')
    expect(text).not.toContain('Fix:')
  })

  it('cites a local hit with no key by case slug alone', () => {
    const text = formatRelatedCitation(localHit({ jiraKey: null }))
    expect(text).toContain('Related history — case `old-case`')
    expect(text).not.toContain('()')
  })

  it('ends with a newline so the user can type straight after it', () => {
    expect(formatRelatedCitation(corpusHit()).endsWith('\n')).toBe(true)
  })
})
