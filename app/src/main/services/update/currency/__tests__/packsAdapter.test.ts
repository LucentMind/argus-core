import { describe, it, expect, vi } from 'vitest'
import { createPacksAdapter, type PackUpdatesLike } from '../packsAdapter'
import type { UpdateStatus } from '../../../../../shared/updates'
import type { Candidate } from '../../../../../shared/currency'

const installed = [{ id: 'code-graph', displayName: 'Code Graph', installedVersion: '1.0.0' }]

function build(
  statuses: Record<string, UpdateStatus>,
  applyResult: UpdateStatus = { phase: 'ready', version: '1.1.0' }
): { updates: PackUpdatesLike; adapter: ReturnType<typeof createPacksAdapter> } {
  const updates: PackUpdatesLike = {
    checkAll: vi.fn(async () => statuses),
    apply: vi.fn(async () => applyResult)
  }
  return { updates, adapter: createPacksAdapter({ updates, installed: () => installed }) }
}

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  domain: 'pack',
  key: 'code-graph',
  label: 'Code Graph',
  from: '1.0.0',
  to: '1.1.0',
  verdict: 'clean',
  ...over
})

describe('packsAdapter.survey', () => {
  it('offers an available update as clean', async () => {
    const { adapter } = build({ 'code-graph': { phase: 'available', version: '1.1.0' } })
    expect(await adapter.survey()).toEqual([candidate()])
  })

  it('returns nothing for a current pack', async () => {
    const { adapter } = build({ 'code-graph': { phase: 'idle' } })
    expect(await adapter.survey()).toEqual([])
  })

  it('blocks an origin-pinned pack', async () => {
    const { adapter } = build({
      'code-graph': { phase: 'error', message: 'pin moved', at: 1, code: 'origin-pin' }
    })
    const [c] = await adapter.survey()
    expect(c.verdict).toBe('blocked')
    expect(c.reason).toEqual({ kind: 'origin-pin' })
  })

  it('blocks on a gh failure', async () => {
    const { adapter } = build({
      'code-graph': { phase: 'error', message: 'gh not signed in', at: 1, code: 'gh' }
    })
    expect((await adapter.survey())[0].reason).toEqual({ kind: 'auth' })
  })

  it('stays silent about an ordinary transport failure', async () => {
    const { adapter } = build({
      'code-graph': { phase: 'error', message: 'ETIMEDOUT', at: 1, code: 'feed' }
    })
    expect(await adapter.survey()).toEqual([])
  })

  it('ignores a pack with no installed row', async () => {
    const { updates } = build({ ghost: { phase: 'available', version: '9.9.9' } })
    const adapter = createPacksAdapter({ updates, installed: () => [] })
    expect(await adapter.survey()).toEqual([])
  })

  it('reports the checkAll statuses through onSurveyed', async () => {
    const statuses: Record<string, UpdateStatus> = {
      'code-graph': { phase: 'available', version: '1.1.0' }
    }
    const updates: PackUpdatesLike = {
      checkAll: vi.fn(async () => statuses),
      apply: vi.fn(async (): Promise<UpdateStatus> => ({ phase: 'ready', version: '1.1.0' }))
    }
    const onSurveyed = vi.fn()
    const adapter = createPacksAdapter({ updates, installed: () => installed, onSurveyed })
    await adapter.survey()
    expect(onSurveyed).toHaveBeenCalledTimes(1)
    expect(onSurveyed).toHaveBeenCalledWith(statuses)
  })
})

describe('packsAdapter.apply', () => {
  it('applies and reports the relaunch requirement', async () => {
    const { adapter, updates } = build({ 'code-graph': { phase: 'available', version: '1.1.0' } })
    expect(await adapter.apply(candidate())).toEqual({ ok: true, needsRelaunch: true })
    expect(updates.apply).toHaveBeenCalledWith('code-graph')
  })

  it('passes NO hooks, so a dependency-adding update is refused rather than staged', async () => {
    const { adapter, updates } = build({ 'code-graph': { phase: 'available', version: '1.1.0' } })
    await adapter.apply(candidate())
    // One argument only: the id. A second argument would be an ApplyHooks object, and passing
    // `planUnsatisfied` is exactly what turns a refusal into a staged plan nobody approved.
    expect((updates.apply as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1)
  })

  it('reports a dependency refusal as a decision for the user', async () => {
    const { adapter } = build(
      { 'code-graph': { phase: 'available', version: '1.1.0' } },
      {
        phase: 'error',
        message: 'requires pack "indexer" which is not installed',
        at: 1,
        code: 'install'
      }
    )
    expect(await adapter.apply(candidate())).toEqual({
      ok: false,
      error: 'requires pack "indexer" which is not installed',
      reason: { kind: 'new-dependency' }
    })
  })

  it('reports an origin-pin refusal at apply time', async () => {
    const { adapter } = build(
      { 'code-graph': { phase: 'available', version: '1.1.0' } },
      {
        phase: 'error',
        message: 'origin changed',
        at: 1,
        code: 'origin-pin'
      }
    )
    expect(await adapter.apply(candidate())).toEqual({
      ok: false,
      error: 'origin changed',
      reason: { kind: 'origin-pin' }
    })
  })

  it('reports a transport failure with no reason, so it is retried not surfaced', async () => {
    const { adapter } = build(
      { 'code-graph': { phase: 'available', version: '1.1.0' } },
      {
        phase: 'error',
        message: 'ECONNRESET',
        at: 1,
        code: 'download'
      }
    )
    expect(await adapter.apply(candidate())).toEqual({ ok: false, error: 'ECONNRESET' })
  })
})
