import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { startPtcServer, type PtcServer } from '../server'
import { generateStubModule, PTC_STUB_VERSION } from '../stub'

let srv: PtcServer | null = null
afterEach(() => {
  srv?.close()
  srv = null
})

function call(
  port: number,
  payload: object
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      s.write(JSON.stringify(payload) + '\n')
    })
    let acc = ''
    s.setEncoding('utf8')
    s.on('data', (d) => {
      acc += d
      const nl = acc.indexOf('\n')
      if (nl !== -1) {
        s.destroy()
        resolve(JSON.parse(acc.slice(0, nl)))
      }
    })
    s.on('error', reject)
  })
}

describe('startPtcServer', () => {
  it('dispatches an allowlisted tool with a valid token', async () => {
    srv = await startPtcServer({
      dispatch: async (tool, args) => ({ echoed: tool, args }),
      allowedTools: ['search_evidence'],
      maxCalls: 5
    })
    const res = await call(srv.port, {
      tool: 'search_evidence',
      args: { query: 'x' },
      token: srv.token
    })
    expect(res.ok).toBe(true)
    expect(res.result).toEqual({ echoed: 'search_evidence', args: { query: 'x' } })
    expect(srv.calls).toBe(1)
  })

  it('rejects a wrong token and a non-allowlisted tool without dispatching', async () => {
    let dispatched = 0
    srv = await startPtcServer({
      dispatch: async () => {
        dispatched++
        return null
      },
      allowedTools: ['search_evidence'],
      maxCalls: 5
    })
    const bad = await call(srv.port, { tool: 'search_evidence', args: {}, token: 'nope' })
    expect(bad.ok).toBe(false)
    const notAllowed = await call(srv.port, { tool: 'write_memory', args: {}, token: srv.token })
    expect(notAllowed.ok).toBe(false)
    expect(notAllowed.error).toMatch(/not allowed/)
    expect(dispatched).toBe(0)
  })

  it('errors past maxCalls', async () => {
    srv = await startPtcServer({ dispatch: async () => 1, allowedTools: ['t'], maxCalls: 2 })
    await call(srv.port, { tool: 't', args: {}, token: srv.token })
    await call(srv.port, { tool: 't', args: {}, token: srv.token })
    const third = await call(srv.port, { tool: 't', args: {}, token: srv.token })
    expect(third.ok).toBe(false)
    expect(third.error).toMatch(/tool-call limit/)
  })

  it('returns dispatch errors as { ok: false } instead of crashing', async () => {
    srv = await startPtcServer({
      dispatch: async () => {
        throw new Error('boom')
      },
      allowedTools: ['t'],
      maxCalls: 5
    })
    const res = await call(srv.port, { tool: 't', args: {}, token: srv.token })
    expect(res).toEqual({ ok: false, error: 'boom' })
  })
})

describe('generateStubModule', () => {
  it('emits one wrapper per tool plus helpers, and a version marker exists', () => {
    const src = generateStubModule(['search_evidence', 'read_memory'])
    expect(src).toContain('module.exports.search_evidence =')
    expect(src).toContain('module.exports.read_memory =')
    expect(src).toContain('jsonParse')
    expect(src).toContain('retry')
    expect(PTC_STUB_VERSION).toMatch(/^\d+$/)
  })
})
