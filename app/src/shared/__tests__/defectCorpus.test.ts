import { describe, it, expect } from 'vitest'
import { defectCorpusSourceSchema, corpusTokenSecret } from '../defectCorpus'

describe('defectCorpus shared types', () => {
  it('corpusTokenSecret names the safeStorage key for a source id', () => {
    expect(corpusTokenSecret('abc')).toBe('defectCorpus/abc/token')
  })

  it('parses a full source entry', () => {
    const cfg = defectCorpusSourceSchema.parse({
      name: 'Hindsight',
      baseUrl: 'https://corpus.example.com',
      enabled: true
    })
    expect(cfg).toEqual({
      name: 'Hindsight',
      baseUrl: 'https://corpus.example.com',
      enabled: true
    })
  })
})
