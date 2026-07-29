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

  // A linked clone's directory name and its GitHub repo name are different strings whenever the
  // user cloned into a custom folder (`hmt-clone` vs `HiveMindTest`). Review findings cite the
  // GITHUB name — the run prompt pins it ("the prefix is exactly <repo>") — so the citation
  // domain must carry the remote-derived name too, or every such citation renders as plain text.
  // Found live 2026-07-29: the acceptance case's citations were dead tags.
  it('adds the remote-derived repo name for a workspace whose folder is named differently', async () => {
    window.argus.workspaces.list = vi.fn(async () => [
      {
        path: 'C:\\tmp\\hmt-clone',
        remote: 'https://github.com/JiaweiHan88/HiveMindTest.git',
        branch: 'main'
      }
    ]) as never
    window.argus.workspaces.refs = vi.fn(async () => []) as never
    await reposStore.load('C-2')
    expect(reposStore.get('C-2').names).toEqual(['hmt-clone', 'HiveMindTest'])
  })

  it('does not duplicate the name when the folder already matches the remote', async () => {
    window.argus.workspaces.list = vi.fn(async () => [
      {
        path: '/home/u/HiveMindTest',
        remote: 'git@github.com:JiaweiHan88/HiveMindTest.git',
        branch: 'main'
      }
    ]) as never
    window.argus.workspaces.refs = vi.fn(async () => []) as never
    await reposStore.load('C-3')
    expect(reposStore.get('C-3').names).toEqual(['HiveMindTest'])
  })

  it('falls back to the remote basename for non-GitHub hosts', async () => {
    window.argus.workspaces.list = vi.fn(async () => [
      {
        path: '/w/checkout',
        remote: 'https://gitlab.example.com/team/inner-tool.git',
        branch: null
      }
    ]) as never
    window.argus.workspaces.refs = vi.fn(async () => []) as never
    await reposStore.load('C-4')
    expect(reposStore.get('C-4').names).toEqual(['checkout', 'inner-tool'])
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
