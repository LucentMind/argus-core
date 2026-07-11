import { describe, it, expect } from 'vitest'
import { buildLangfuseClient } from '../langfuseClient'

describe('buildLangfuseClient', () => {
  it('returns a client exposing the LangfuseClientLike surface', () => {
    const c = buildLangfuseClient({ host: 'https://lf.example', publicKey: 'pk', secretKey: 'sk' })
    for (const m of ['trace', 'generation', 'span', 'score', 'flushAsync', 'shutdownAsync']) {
      expect(typeof (c as unknown as Record<string, unknown>)[m]).toBe('function')
    }
  })
})
