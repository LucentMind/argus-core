import { describe, it, expect } from 'vitest'
import { PendingApprovals, SessionGrants } from '../approvals'

const req = (id: string) => ({
  requestId: id,
  tool: 'Bash',
  risk: 'MEDIUM' as const,
  grantKey: 'ws:cwd',
  argsPreview: 'git fetch'
})

describe('PendingApprovals', () => {
  it('resolves an open request with the user decision', async () => {
    const pa = new PendingApprovals()
    const p = pa.open(req('r1'))
    expect(pa.size).toBe(1)
    expect(pa.resolve('r1', 'allow')).toBe(true)
    await expect(p).resolves.toEqual({ decision: 'allow', comment: undefined })
    expect(pa.size).toBe(0)
  })

  it('returns false for unknown requestIds', () => {
    expect(new PendingApprovals().resolve('nope', 'allow')).toBe(false)
  })

  it('cancels on abort signal', async () => {
    const pa = new PendingApprovals()
    const ac = new AbortController()
    const p = pa.open(req('r2'), ac.signal)
    ac.abort()
    await expect(p).resolves.toEqual({ decision: 'cancelled', comment: undefined })
    expect(pa.size).toBe(0)
  })

  it('drain cancels everything pending and reports ids', async () => {
    const pa = new PendingApprovals()
    const p1 = pa.open(req('a'))
    const p2 = pa.open(req('b'))
    expect(pa.drain().sort()).toEqual(['a', 'b'])
    await expect(p1).resolves.toMatchObject({ decision: 'cancelled' })
    await expect(p2).resolves.toMatchObject({ decision: 'cancelled' })
  })
})

describe('SessionGrants', () => {
  it('remembers granted keys', () => {
    const g = new SessionGrants()
    expect(g.has('ws:repo')).toBe(false)
    g.add('ws:repo')
    expect(g.has('ws:repo')).toBe(true)
  })
})
