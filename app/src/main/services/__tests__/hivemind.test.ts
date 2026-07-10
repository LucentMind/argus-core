import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HivemindService, cloneUrl, type Runner } from '../hivemind'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-hive-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

/** Fake git that records calls and serves canned outputs per subcommand. */
function fakeGit(outputs: Record<string, string> = {}): { runner: Runner; calls: string[][] } {
  const calls: string[][] = []
  const runner: Runner = async (_cmd, args) => {
    calls.push(args)
    return outputs[args[0]] ?? ''
  }
  return { runner, calls }
}

function seedClone(): string {
  const clone = path.join(home, 'hivemind')
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true })
  fs.mkdirSync(path.join(clone, 'skills', 'hive-probe'), { recursive: true })
  fs.writeFileSync(
    path.join(clone, 'skills', 'hive-probe', 'SKILL.md'),
    '---\ndescription: probe skill from the hive\n---\n# hive-probe\n'
  )
  fs.mkdirSync(path.join(clone, 'references'), { recursive: true })
  fs.writeFileSync(path.join(clone, 'references', 'hive-note.md'), '# note\n')
  return clone
}

describe('cloneUrl', () => {
  it('expands org/name to a GitHub https URL and passes URLs/paths through', () => {
    expect(cloneUrl('acme/hivemind')).toBe('https://github.com/acme/hivemind.git')
    expect(cloneUrl('https://example.com/x.git')).toBe('https://example.com/x.git')
    expect(cloneUrl('C:\\tmp\\bare.git')).toBe('C:\\tmp\\bare.git')
  })
})

describe('HivemindService states', () => {
  it('is dormant without a repo and never runs git', async () => {
    const { runner, calls } = fakeGit()
    const svc = new HivemindService({ argusHome: home, repo: () => '', git: runner })
    const p = await svc.payload()
    expect(p.state).toBe('dormant')
    expect(calls).toEqual([])
  })

  it('is not-cloned before the first sync; sync clones', async () => {
    const { runner, calls } = fakeGit()
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    expect((await svc.payload()).state).toBe('not-cloned')
    await svc.sync()
    expect(calls[0]).toEqual([
      'clone',
      'https://github.com/acme/hivemind.git',
      path.join(home, 'hivemind')
    ])
  })

  it('sync pulls --ff-only on an existing clone and stamps lastSynced', async () => {
    seedClone()
    const { runner, calls } = fakeGit({ 'rev-parse': 'headsha', log: 'itemsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.sync()
    expect(calls.some((c) => c[0] === 'pull' && c.includes('--ff-only'))).toBe(true)
    expect(calls.every((c) => !c.includes('--force'))).toBe(true)
    expect(p.state).toBe('ready')
    expect(p.lastSynced).toBeTruthy()
    expect(p.headCommit).toBe('headsha')
  })

  it('a failing pull surfaces as an error payload, clone left alone', async () => {
    seedClone()
    const runner: Runner = async (_c, args) => {
      if (args[0] === 'pull') throw new Error('divergent history')
      return 'x'
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.sync()
    expect(p.state).toBe('error')
    expect(p.error).toMatch(/divergent/)
  })
})

describe('browse + install pinning', () => {
  it('lists skills (with frontmatter description) and references', async () => {
    seedClone()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'itemsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.payload()
    const names = p.items.map((i) => `${i.kind}:${i.name}`)
    expect(names).toContain('skill:hive-probe')
    expect(names).toContain('reference:hive-note.md')
    expect(p.items.find((i) => i.name === 'hive-probe')?.description).toBe(
      'probe skill from the hive'
    )
    expect(p.items.every((i) => !i.installed)).toBe(true)
  })

  it('install copies a skill into the hivemind tier, pins the sha, flags updates', async () => {
    seedClone()
    const git = fakeGit({ 'rev-parse': 'headsha', log: 'sha-1' })
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: git.runner
    })
    let p = await svc.install('skill', 'hive-probe')
    expect(fs.existsSync(path.join(home, 'skills-hivemind', 'hive-probe', 'SKILL.md'))).toBe(true)
    let item = p.items.find((i) => i.name === 'hive-probe')!
    expect(item.installed).toBe(true)
    expect(item.installedCommit).toBe('sha-1')
    expect(item.updateAvailable).toBe(false)
    // upstream moves: per-item log sha changes -> update flagged, installed copy untouched
    const svc2 = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: fakeGit({ 'rev-parse': 'headsha2', log: 'sha-2' }).runner
    })
    p = await svc2.payload()
    item = p.items.find((i) => i.name === 'hive-probe')!
    expect(item.updateAvailable).toBe(true)
    expect(
      fs.readFileSync(path.join(home, 'skills-hivemind', 'hive-probe', 'SKILL.md'), 'utf8')
    ).toContain('hive-probe')
  })

  it('install stamps references with trust_tier: hivemind + provenance', async () => {
    seedClone()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.install('reference', 'hive-note.md')
    const written = fs.readFileSync(path.join(home, 'references', 'hive-note.md'), 'utf8')
    expect(written).toContain('trust_tier: hivemind')
    expect(written).toContain('source_repo: acme/hivemind')
    expect(written).toContain('source_commit: refsha')
  })

  it('diff asks git for pinned..HEAD on the item path', async () => {
    seedClone()
    const git = fakeGit({ 'rev-parse': 'headsha', log: 'sha-1', diff: 'THE DIFF' })
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: git.runner
    })
    await svc.install('skill', 'hive-probe')
    const d = await svc.diff('skill', 'hive-probe')
    expect(d).toBe('THE DIFF')
    expect(
      git.calls.some((c) => c[0] === 'diff' && c.includes('sha-1') && c.includes('HEAD'))
    ).toBe(true)
  })
})
