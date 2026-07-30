import { describe, it, expect, beforeEach } from 'vitest'
import { identity, resetIdentityCache, type IdentityRunner } from '../authorship'
import { authorName, formatIdentity, parseAuthorship } from '../../../shared/authorship'

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

  // `author: <name> <email>` is emitted as a BARE plain YAML scalar, and SKILL.md is parsed by
  // real YAML readers (the Claude CLI, Copilot's skillDirectories) — not only by this repo's
  // regex helpers. A name that cannot survive as a plain scalar breaks the WHOLE frontmatter
  // block, so `name:` and `description:` become unreadable too. Falling back to the address's
  // local part keeps a usable byline instead of losing authorship entirely.
  it.each([
    ['a mapping-value indicator', 'Ops: Platform'],
    ['a trailing colon', 'Ops:'],
    ['a comment start', 'Alex #1'],
    ['a leading comment start', '#1 Alex'],
    ['a leading alias indicator', '*Alex'],
    ['a leading anchor indicator', '&Alex'],
    ['a leading tag indicator', '!Alex'],
    ['a leading directive indicator', '%Alex'],
    ['a leading reserved indicator', '@Alex'],
    ['a leading backtick', '`Alex'],
    ['a leading quote', '"Alex"'],
    ['a leading flow indicator', '[Alex]'],
    ['a leading block-sequence dash', '- Alex']
  ])('falls back rather than emitting %s in the author line', async (_label, name) => {
    const { run } = fakeGit({ 'user.name': name, 'user.email': 'ops@x.test' })
    await expect(identity(run)).resolves.toEqual({ name: 'ops', email: 'ops@x.test' })
  })

  it.each([
    ['an internal colon with no space', 'Ops:Platform'],
    ['an internal hash with no space', 'Alex#1'],
    ['a hyphenated name', 'Jean-Luc Picard'],
    ['a name with a dot and comma', 'Han, J.']
  ])('keeps %s — these are legal plain scalars', async (_label, name) => {
    const { run } = fakeGit({ 'user.name': name, 'user.email': 'ops@x.test' })
    await expect(identity(run)).resolves.toEqual({ name, email: 'ops@x.test' })
  })

  it('the emitted author line round-trips back through parseAuthorship', async () => {
    const { run } = fakeGit({ 'user.name': 'Ops: Platform', 'user.email': 'ops@x.test' })
    const id = await identity(run)
    const line = `---\nauthor: ${formatIdentity(id!)}\n---\nbody\n`
    expect(parseAuthorship(line).author).toBe('ops <ops@x.test>')
    expect(authorName(parseAuthorship(line).author)).toBe('ops')
    // nothing in the emitted scalar can start a comment or a nested mapping
    expect(line).not.toMatch(/author: .*(:(\s|$)|(^|\s)#)/m)
  })
})
