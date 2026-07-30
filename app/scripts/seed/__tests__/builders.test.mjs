import { describe, expect, it } from 'vitest'
import { createCtx } from '../ctx.mjs'

describe('createCtx', () => {
  const ctx = createCtx({ argusHome: 'C:/home', db: null })

  it('lists the five slugs in roster order', () => {
    expect(ctx.SLUGS).toEqual([
      'HMT-1-burst-token',
      'HMT-2-green',
      'HMT-3-cancelled',
      'HMT-4-nochecks',
      'SYN-5-edge'
    ])
  })

  it('maps every slug to its pull request number', () => {
    expect(ctx.PR_NUMBERS).toEqual({
      'HMT-1-burst-token': 4,
      'HMT-2-green': 6,
      'HMT-3-cancelled': 7,
      'HMT-4-nochecks': 5,
      'SYN-5-edge': 999
    })
  })

  it('builds the worktree path the app computes', () => {
    expect(ctx.worktreeDir('hmt', 'HMT-1-burst-token', 4).replace(/\\/g, '/')).toBe(
      'C:/home/worktrees/hmt-HMT-1-burst-token-pr4'
    )
  })
})
