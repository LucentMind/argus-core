import { describe, it, expect } from 'vitest'
import { formatDefectRecordCitation, formatRelatedCitation } from '../relatedCitation'
import type {
  CorpusDefectHit,
  LocalCaseHit,
  RelatedDefectRecord
} from '../../../../shared/relatedHistory'

const record = (over: Partial<RelatedDefectRecord> = {}): RelatedDefectRecord => ({
  key: 'KAN-9',
  url: 'https://corpus.example/browse/KAN-9',
  project: 'KAN',
  summary: 'plan cleared on resume',
  description: 'It drops the plan.',
  status: 'Done',
  resolution: 'Fixed',
  components: [],
  labels: [],
  affectsVersions: [],
  fixVersions: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  resolvedAt: null,
  links: [],
  commentCount: 0,
  distilled: null,
  ...over
})

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

// A record — not a hit — is all that exists once the user follows a `links[]`
// entry in the detail pane, so the pull-into-case citation needs this sibling to
// be able to cite what the pane is actually showing.
describe('formatDefectRecordCitation', () => {
  it('cites a record with key, source, summary, status, url and distilled lines', () => {
    const text = formatDefectRecordCitation(
      record({
        distilled: {
          signature: 'plan cleared on resume',
          symptoms: 'plan is null',
          rootCause: 'cache cleared before reload',
          fix: 'reload before clearing',
          errorStrings: ['E_PLAN_NULL'],
          distilledAt: '2026-01-04T00:00:00.000Z'
        }
      }),
      'Hindsight'
    )
    expect(text).toContain('Related history — KAN-9 (Hindsight)')
    expect(text).toContain('plan cleared on resume')
    expect(text).toContain('Status: Done / Fixed')
    expect(text).toContain('URL: https://corpus.example/browse/KAN-9')
    expect(text).toContain('Signature: plan cleared on resume')
    expect(text).toContain('Fix: reload before clearing')
  })

  it('drops a non-http(s) url entirely rather than citing it', () => {
    const text = formatDefectRecordCitation(record({ url: 'javascript:alert(1)' }), 'Hindsight')
    expect(text).not.toContain('javascript:')
    expect(text).not.toContain('URL:')
  })

  it('drops a file:// url too — the gate is a scheme allowlist, not a blocklist', () => {
    const text = formatDefectRecordCitation(record({ url: 'file:///etc/passwd' }), 'Hindsight')
    expect(text).not.toContain('URL:')
  })

  it('keeps an http url as well as https', () => {
    const text = formatDefectRecordCitation(record({ url: 'http://corpus.example/x' }), 'Hindsight')
    expect(text).toContain('URL: http://corpus.example/x')
  })

  it('states an unresolved status without a resolution half', () => {
    const text = formatDefectRecordCitation(record({ resolution: null }), 'Hindsight')
    expect(text).toContain('Status: Done')
    expect(text).not.toContain('Status: Done /')
  })

  it('omits both distilled lines when the record has no distilled block', () => {
    const text = formatDefectRecordCitation(record(), 'Hindsight')
    expect(text).not.toContain('Signature:')
    expect(text).not.toContain('Fix:')
  })

  it('ends with a newline, exactly like the hit citation', () => {
    expect(formatDefectRecordCitation(record(), 'Hindsight').endsWith('\n')).toBe(true)
  })
})
