import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  writeProposal,
  acceptProposal,
  rejectProposal,
  removePendingProposal,
  setProposalsChangedNotifier,
  proposalCounts,
  batchProposalChanges
} from '../proposals'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-notify-'))
})
afterEach(() => {
  setProposalsChangedNotifier(() => {})
  fs.rmSync(home, { recursive: true, force: true })
})

describe('proposals changed notifier', () => {
  it('fires on write, accept, reject, and remove', () => {
    const cb = vi.fn()
    setProposalsChangedNotifier(cb)

    const f1 = writeProposal(home, 'case-a', {
      type: 'reference-edit',
      target: 'foo',
      title: 'T1',
      content: 'body'
    })
    expect(cb).toHaveBeenCalledTimes(1)

    acceptProposal(home, f1)
    expect(cb).toHaveBeenCalledTimes(2)

    const f2 = writeProposal(home, 'case-a', {
      type: 'recipe',
      target: 'bar',
      title: 'T2',
      content: 'body2'
    })
    rejectProposal(home, f2)
    expect(cb).toHaveBeenCalledTimes(4)

    const f3 = writeProposal(home, 'case-a', {
      type: 'recipe',
      target: 'baz',
      title: 'T3',
      content: 'body3'
    })
    removePendingProposal(home, f3)
    expect(cb).toHaveBeenCalledTimes(6)
  })

  it('batchProposalChanges coalesces a burst of changes into one notification', () => {
    const cb = vi.fn()
    setProposalsChangedNotifier(cb)
    const result = batchProposalChanges(() => {
      writeProposal(home, 'c', { type: 'recipe', target: 'a', title: 't', content: 'x' })
      writeProposal(home, 'c', { type: 'recipe', target: 'b', title: 't', content: 'x' })
      const f = writeProposal(home, 'c', { type: 'recipe', target: 'd', title: 't', content: 'x' })
      removePendingProposal(home, f)
      expect(cb).not.toHaveBeenCalled()
      return 'done'
    })
    expect(result).toBe('done')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('batchProposalChanges with no changes inside does not notify', () => {
    const cb = vi.fn()
    setProposalsChangedNotifier(cb)
    batchProposalChanges(() => {})
    expect(cb).not.toHaveBeenCalled()
  })

  it('batchProposalChanges still notifies once when the batch throws mid-way', () => {
    const cb = vi.fn()
    setProposalsChangedNotifier(cb)
    expect(() =>
      batchProposalChanges(() => {
        writeProposal(home, 'c', { type: 'recipe', target: 'a', title: 't', content: 'x' })
        throw new Error('boom')
      })
    ).toThrow('boom')
    // the write above landed on disk — listeners must still hear about it
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('proposalCounts aggregates pending by type', () => {
    writeProposal(home, 'c', { type: 'reference-edit', target: 'a', title: 't', content: 'x' })
    writeProposal(home, 'c', { type: 'recipe', target: 'b', title: 't', content: 'x' })
    writeProposal(home, 'c', { type: 'recipe', target: 'd', title: 't', content: 'x' })
    expect(proposalCounts(home)).toEqual({
      pendingCount: 3,
      byType: { 'reference-edit': 1, recipe: 2 }
    })
  })
})
