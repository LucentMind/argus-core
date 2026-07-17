// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reposStore } from '../reposStore'

beforeEach(() => {
  reposStore.clearForTests()
  window.argus = {
    workspaces: {
      list: vi.fn(async () => [
        { path: 'C:\\repos\\hivemindtest', remote: null, branch: 'main' },
        { path: '/home/u/other-repo', remote: null, branch: null }
      ]),
      refs: vi.fn(async () => [
        { remote: 'git@github.com:x/imported-repo.git', branch: 'main', commit: 'abc' },
        { remote: null, branch: null, commit: null }
      ])
    }
  } as never
})

describe('reposStore', () => {
  it('loads basenames from linked workspaces and imported refs', async () => {
    await reposStore.load('C-1')
    expect(reposStore.get('C-1').names).toEqual(['hivemindtest', 'other-repo', 'imported-repo'])
  })

  it('returns a stable empty snapshot for unknown cases', () => {
    expect(reposStore.get('nope')).toBe(reposStore.get('nope'))
    expect(reposStore.get('nope').names).toEqual([])
  })

  it('notifies subscribers on load', async () => {
    const cb = vi.fn()
    reposStore.subscribe(cb)
    await reposStore.load('C-1')
    expect(cb).toHaveBeenCalled()
  })
})
