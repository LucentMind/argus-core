import { describe, it, expect, vi } from 'vitest'
import { createHiveAdapter, type HivemindLike } from '../hiveAdapter'
import type { HivemindItem, HivemindPayload, LocalDivergence } from '../../../../../shared/hivemind'
import type { Candidate } from '../../../../../shared/currency'

const item = (over: Partial<HivemindItem> = {}): HivemindItem => ({
  kind: 'skill',
  name: 'triage',
  description: 'Triage a case',
  author: null,
  commit: 'def456',
  installed: true,
  installedCommit: 'abc123',
  localTier: null,
  shadowedByUser: false,
  updateAvailable: true,
  orphaned: false,
  ...over
})

const clean: LocalDivergence = { diverged: false, diff: '', tierChange: null }

function build(
  items: HivemindItem[],
  over: { declined?: Record<string, string>; divergence?: LocalDivergence } = {}
): { service: HivemindLike; adapter: ReturnType<typeof createHiveAdapter> } {
  const payload = (): HivemindPayload => ({
    repo: 'org/hive',
    state: 'ready',
    error: null,
    headCommit: 'def456',
    lastSynced: '2026-08-20T00:00:00.000Z',
    items,
    pushable: [],
    pushes: {}
  })
  const service: HivemindLike = {
    sync: vi.fn(async () => payload()),
    payload: vi.fn(async () => payload()),
    localDivergence: vi.fn(async () => over.divergence ?? clean),
    install: vi.fn(async () => payload()),
    declined: () => over.declined ?? {}
  }
  return { service, adapter: createHiveAdapter({ service }) }
}

describe('hiveAdapter.survey', () => {
  it('syncs the clone before deciding anything', async () => {
    const { adapter, service } = build([])
    await adapter.survey()
    expect(service.sync).toHaveBeenCalledTimes(1)
  })

  it('offers an updatable, undiverged skill as clean', async () => {
    const { adapter } = build([item()])
    expect(await adapter.survey()).toEqual([
      {
        domain: 'hive-skill',
        key: 'skill/triage',
        label: 'triage',
        from: 'abc123',
        to: 'def456',
        verdict: 'clean'
      }
    ])
  })

  it('adopts a new item the user has never installed', async () => {
    const { adapter } = build([
      item({ name: 'rca', installed: false, installedCommit: null, updateAvailable: false })
    ])
    const [c] = await adapter.survey()
    expect(c).toMatchObject({ key: 'skill/rca', from: null, to: 'def456', verdict: 'clean' })
  })

  it('never adopts a tombstoned item', async () => {
    const { adapter } = build(
      [item({ name: 'rca', installed: false, installedCommit: null, updateAvailable: false })],
      { declined: { 'skill/rca': '2026-08-19T00:00:00.000Z' } }
    )
    expect(await adapter.survey()).toEqual([])
  })

  it('blocks a diverged reference', async () => {
    const { adapter } = build(
      [item({ kind: 'reference', name: 'style.md', localTier: 'hivemind' })],
      { divergence: { diverged: true, diff: '- a\n+ b', tierChange: null } }
    )
    const [c] = await adapter.survey()
    expect(c.domain).toBe('hive-reference')
    expect(c.reason).toEqual({ kind: 'local-edits' })
  })

  it('blocks a reference whose tier would be restamped', async () => {
    const { adapter } = build([item({ kind: 'reference', name: 'style.md', localTier: 'mine' })], {
      divergence: { diverged: false, diff: '', tierChange: { from: 'mine', to: 'hivemind' } }
    })
    expect((await adapter.survey())[0].reason).toEqual({
      kind: 'tier-change',
      from: 'mine',
      to: 'hivemind'
    })
  })

  it('never offers an orphan', async () => {
    const { adapter } = build([item({ orphaned: true, updateAvailable: false })])
    expect(await adapter.survey()).toEqual([])
  })

  it('does not run the divergence check on skills', async () => {
    const { adapter, service } = build([item()])
    await adapter.survey()
    expect(service.localDivergence).not.toHaveBeenCalled()
  })
})

describe('hiveAdapter.apply', () => {
  const cand: Candidate = {
    domain: 'hive-reference',
    key: 'reference/style.md',
    label: 'style.md',
    from: 'abc123',
    to: 'def456',
    verdict: 'clean'
  }

  it('installs without overwriteLocalEdits', async () => {
    const { adapter, service } = build([])
    expect(await adapter.apply(cand)).toEqual({ ok: true })
    expect(service.install).toHaveBeenCalledWith('reference', 'style.md')
  })

  it('REFUSES an item that became diverged after the survey', async () => {
    const { adapter, service } = build([], {
      divergence: { diverged: true, diff: '- a\n+ b', tierChange: null }
    })
    expect(await adapter.apply(cand)).toEqual({
      ok: false,
      error: 'style.md was edited locally since it was checked',
      reason: { kind: 'local-edits' }
    })
    expect(service.install).not.toHaveBeenCalled()
  })

  it('REFUSES an item whose tier change appeared after the survey', async () => {
    const { adapter, service } = build([], {
      divergence: { diverged: false, diff: '', tierChange: { from: 'mine', to: 'hivemind' } }
    })
    expect(await adapter.apply(cand)).toMatchObject({
      ok: false,
      reason: { kind: 'tier-change', from: 'mine', to: 'hivemind' }
    })
    expect(service.install).not.toHaveBeenCalled()
  })

  it('does not re-derive for a skill, which has no divergence concept', async () => {
    const { adapter, service } = build([])
    await adapter.apply({ ...cand, domain: 'hive-skill', key: 'skill/triage', label: 'triage' })
    expect(service.localDivergence).not.toHaveBeenCalled()
    expect(service.install).toHaveBeenCalledWith('skill', 'triage')
  })
})
