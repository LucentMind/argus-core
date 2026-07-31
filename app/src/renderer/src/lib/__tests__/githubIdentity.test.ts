// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { githubLogin, resetGithubIdentity } from '../githubIdentity'

function bridge(status: unknown): void {
  window.argus = { sourceControl: { status } } as never
}

beforeEach(() => {
  resetGithubIdentity()
})

describe('githubLogin', () => {
  it('resolves the gh login', async () => {
    bridge(vi.fn().mockResolvedValue({ authenticated: true, login: 'octocat' }))
    await expect(githubLogin()).resolves.toBe('octocat')
  })

  // The whole point of the cache: `gh --version` + `gh auth status` are two subprocess spawns,
  // and home is mounted again on every return from a case.
  it('spawns gh at most once per renderer session', async () => {
    const status = vi.fn().mockResolvedValue({ login: 'octocat' })
    bridge(status)
    await Promise.all([githubLogin(), githubLogin()])
    await githubLogin()
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('is null when gh is installed but not logged in', async () => {
    bridge(vi.fn().mockResolvedValue({ authenticated: false, login: null }))
    await expect(githubLogin()).resolves.toBeNull()
  })

  it('is null when the call rejects', async () => {
    bridge(vi.fn().mockRejectedValue(new Error('ipc failed')))
    await expect(githubLogin()).resolves.toBeNull()
  })

  // Suites that render the dashboard mock only the bridges they exercise; an absent
  // sourceControl must degrade to the bare greeting, not throw through the render.
  it('is null when the bridge is absent entirely', async () => {
    window.argus = {} as never
    await expect(githubLogin()).resolves.toBeNull()
  })
})
