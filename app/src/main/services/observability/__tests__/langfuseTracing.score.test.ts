import { describe, it, expect, vi, afterEach } from 'vitest'

const create = vi.fn()
vi.mock('@langfuse/client', () => ({
  LangfuseClient: class {
    score = { create }
    api = {}
  }
}))

import { setLangfuseTracerProvider } from '@langfuse/tracing'
import { createLangfuseTracing } from '../langfuseTracing'

const cfg = { host: 'https://example.test', publicKey: 'pk', secretKey: 'sk' }

afterEach(() => {
  setLangfuseTracerProvider(null)
  create.mockReset()
})

describe('createLangfuseTracing createScore', () => {
  it('forwards metadata to client.score.create when given', async () => {
    const api = createLangfuseTracing(cfg)
    await api.createScore({
      traceId: 't',
      name: 'asset.contribution',
      value: 1,
      comment: 'why',
      metadata: { a: 1 }
    })
    expect(create).toHaveBeenCalledWith({
      traceId: 't',
      name: 'asset.contribution',
      value: 1,
      comment: 'why',
      metadata: { a: 1 }
    })
    await api.shutdown()
  })

  it('omits metadata and comment keys when absent', async () => {
    const api = createLangfuseTracing(cfg)
    await api.createScore({ traceId: 't', name: 'n', value: 0 })
    expect(create).toHaveBeenCalledWith({ traceId: 't', name: 'n', value: 0 })
    await api.shutdown()
  })
})
