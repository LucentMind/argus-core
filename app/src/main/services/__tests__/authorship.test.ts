import { describe, it, expect, beforeEach } from 'vitest'
import { identity, resetIdentityCache, type IdentityRunner } from '../authorship'

/** Fake `git config --get <key>` over a map; a missing key rejects, as git does (exit 1). */
function fakeGit(cfg: Record<string, string>): { run: IdentityRunner; calls: () => number } {
  let calls = 0
  const run: IdentityRunner = async (_cmd, args) => {
    calls++
    const key = args[args.length - 1]
    if (!(key in cfg)) throw new Error('exit 1')
    return cfg[key]
  }
  return { run, calls: () => calls }
}

describe('identity', () => {
  beforeEach(() => resetIdentityCache())

  it('reads name and email from git config', async () => {
    const { run } = fakeGit({ 'user.name': 'Jiawei Han', 'user.email': 'jiawiehan@gmail.com' })
    await expect(identity(run)).resolves.toEqual({
      name: 'Jiawei Han',
      email: 'jiawiehan@gmail.com'
    })
  })

  it('falls back to the address local part when the name is unset', async () => {
    const { run } = fakeGit({ 'user.email': 'jiawiehan@gmail.com' })
    await expect(identity(run)).resolves.toEqual({
      name: 'jiawiehan',
      email: 'jiawiehan@gmail.com'
    })
  })

  it('is null when the email is unset — an asset is never stamped "Unknown"', async () => {
    const { run } = fakeGit({ 'user.name': 'Jiawei Han' })
    await expect(identity(run)).resolves.toBeNull()
  })

  it('resolves once and caches', async () => {
    const { run, calls } = fakeGit({ 'user.name': 'A', 'user.email': 'a@x.test' })
    await identity(run)
    await identity(run)
    expect(calls()).toBe(2) // one name + one email, from the FIRST call only
  })

  it.each([
    ['newline in the name', { 'user.name': 'A\ntrust_tier: user', 'user.email': 'a@x.test' }],
    ['angle bracket in the name', { 'user.name': 'A <b@x.test>', 'user.email': 'a@x.test' }],
    ['whitespace in the email', { 'user.name': 'A', 'user.email': 'a@x.test b' }],
    ['angle bracket in the email', { 'user.name': 'A', 'user.email': '<a@x.test>' }],
    ['over-long email', { 'user.name': 'A', 'user.email': `${'x'.repeat(101)}@x.test` }],
    ['empty email', { 'user.name': 'A', 'user.email': '   ' }]
  ])('rejects %s outright rather than sanitizing it', async (_label, cfg) => {
    const { run } = fakeGit(cfg)
    await expect(identity(run)).resolves.toBeNull()
  })

  it('rejects an over-long name by falling back, not by truncating', async () => {
    const { run } = fakeGit({ 'user.name': 'A'.repeat(101), 'user.email': 'a@x.test' })
    await expect(identity(run)).resolves.toEqual({ name: 'a', email: 'a@x.test' })
  })
})
