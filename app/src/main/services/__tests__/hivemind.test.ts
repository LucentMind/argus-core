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
      if (args[0] === 'remote') return 'https://github.com/acme/hivemind.git'
      return 'x'
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.sync()
    expect(p.state).toBe('error')
    expect(p.error).toMatch(/divergent/)
  })
})

describe('repo switch', () => {
  const OLD_URL = 'https://github.com/acme/old.git'

  it('payload hides a clone from a different repo instead of listing its items', async () => {
    seedClone()
    const { runner } = fakeGit({ remote: OLD_URL, 'rev-parse': 'headsha', log: 'sha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/new', git: runner })
    const p = await svc.payload()
    expect(p.state).toBe('not-cloned')
    expect(p.items).toEqual([])
    // read-only: the stale clone stays on disk for sync to replace
    expect(fs.existsSync(path.join(home, 'hivemind', '.git'))).toBe(true)
  })

  it('sync replaces a clone whose origin mismatches and drops the old pins', async () => {
    seedClone()
    // install from the old repo so a pin exists
    const old = fakeGit({ remote: OLD_URL, 'rev-parse': 'headsha', log: 'oldsha' })
    const svcOld = new HivemindService({ argusHome: home, repo: () => 'acme/old', git: old.runner })
    await svcOld.install('skill', 'hive-probe')

    let origin = OLD_URL
    const calls: string[][] = []
    const runner: Runner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'remote') return origin
      if (args[0] === 'clone') {
        // simulate git: fresh clone of repo B, which also happens to ship 'hive-probe'
        origin = args[1]
        const dest = args[2]
        for (const skill of ['new-skill', 'hive-probe']) {
          fs.mkdirSync(path.join(dest, 'skills', skill), { recursive: true })
          fs.writeFileSync(
            path.join(dest, 'skills', skill, 'SKILL.md'),
            `---\ndescription: ${skill} from repo B\n---\n`
          )
        }
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true })
        return ''
      }
      if (args[0] === 'rev-parse') return 'newhead'
      if (args[0] === 'log') return 'newsha'
      return ''
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/new', git: runner })
    const p = await svc.sync()

    expect(calls.some((c) => c[0] === 'clone' && c[1] === 'https://github.com/acme/new.git')).toBe(
      true
    )
    expect(calls.every((c) => c[0] !== 'pull')).toBe(true)
    expect(p.state).toBe('ready')
    expect(p.items.map((i) => i.name)).toContain('new-skill')
    // the installed copy survives the switch, but its repo-A pin does not:
    // no cross-repo updateAvailable from comparing old-repo shas to new-repo shas
    expect(fs.existsSync(path.join(home, 'skills-hivemind', 'hive-probe', 'SKILL.md'))).toBe(true)
    const probe = p.items.find((i) => i.name === 'hive-probe')!
    expect(probe.installed).toBe(true)
    expect(probe.installedCommit).toBeNull()
    expect(probe.updateAvailable).toBe(false)
  })

  it('sync pulls in place when the clone origin matches the configured repo', async () => {
    seedClone()
    const { runner, calls } = fakeGit({
      remote: 'https://github.com/acme/hivemind.git',
      'rev-parse': 'headsha',
      log: 'sha'
    })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.sync()
    expect(calls.some((c) => c[0] === 'pull')).toBe(true)
    expect(calls.every((c) => c[0] !== 'clone')).toBe(true)
    expect(p.state).toBe('ready')
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

  it('uninstallSkill removes the installed copy and clears the pin', async () => {
    seedClone()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'sha-1' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.install('skill', 'hive-probe')
    expect(fs.existsSync(path.join(home, 'skills-hivemind', 'hive-probe'))).toBe(true)

    const p = await svc.uninstallSkill('hive-probe')
    expect(fs.existsSync(path.join(home, 'skills-hivemind', 'hive-probe'))).toBe(false)
    const item = p.items.find((i) => i.name === 'hive-probe')!
    expect(item.installed).toBe(false)
    expect(item.installedCommit).toBeNull()
    expect(item.updateAvailable).toBe(false)
  })

  it('uninstallSkill rejects traversal, hidden, and not-installed names', async () => {
    seedClone()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'sha-1' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await expect(svc.uninstallSkill('../evil')).rejects.toThrow(/Invalid skill name/)
    await expect(svc.uninstallSkill('a\\b')).rejects.toThrow(/Invalid skill name/)
    await expect(svc.uninstallSkill('.hidden')).rejects.toThrow(/Invalid skill name/)
    await expect(svc.uninstallSkill('')).rejects.toThrow(/Invalid skill name/)
    await expect(svc.uninstallSkill('hive-probe')).rejects.toThrow(
      /Not an installed HiveMind skill/
    )
  })

  it('uninstallReference removes the installed local copy and clears the pin', async () => {
    seedClone()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.install('reference', 'hive-note.md')
    expect(fs.existsSync(path.join(home, 'references', 'hive-note.md'))).toBe(true)

    const p = await svc.uninstallReference('hive-note.md')
    expect(fs.existsSync(path.join(home, 'references', 'hive-note.md'))).toBe(false)
    const item = p.items.find((i) => i.name === 'hive-note.md')!
    expect(item.installed).toBe(false)
    expect(item.installedCommit).toBeNull()
    expect(item.localTier).toBeNull()
  })

  it('uninstallReference handles flattened confluence names', async () => {
    seedClone()
    const dir = path.join(home, 'hivemind', 'references', 'confluence')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'adasis.md'), '# adasis distilled\n')
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.install('reference', 'confluence/adasis.md')
    expect(fs.existsSync(path.join(home, 'references', 'adasis.md'))).toBe(true)

    const p = await svc.uninstallReference('confluence/adasis.md')
    expect(fs.existsSync(path.join(home, 'references', 'adasis.md'))).toBe(false)
    expect(p.items.find((i) => i.name === 'confluence/adasis.md')!.installed).toBe(false)
  })

  it('uninstallReference rejects invalid, not-installed, and user-authored names', async () => {
    seedClone()
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'references', 'mine.md'),
      '---\ntrust_tier: user\n---\nmy draft\n'
    )
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await expect(svc.uninstallReference('../evil.md')).rejects.toThrow(/Invalid reference name/)
    await expect(svc.uninstallReference('drafts/x.md')).rejects.toThrow(/Invalid reference name/)
    await expect(svc.uninstallReference('ghost.md')).rejects.toThrow(
      /Not an installed HiveMind reference/
    )
    // user-tier local copies are the user's own content — never hive-deletable
    await expect(svc.uninstallReference('mine.md')).rejects.toThrow(
      /Not an installed HiveMind reference/
    )
    expect(fs.existsSync(path.join(home, 'references', 'mine.md'))).toBe(true)
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

describe('pushable + push', () => {
  function seedUserAssets(): void {
    fs.mkdirSync(path.join(home, 'skills-user', 'my-skill'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'skills-user', 'my-skill', 'SKILL.md'),
      '---\ndescription: mine\n---\n# my-skill\n'
    )
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'references', 'team-tips.md'),
      '---\ntrust_tier: team-knowledge\n---\ntips\n'
    )
    fs.writeFileSync(
      path.join(home, 'references', 'synced.md'),
      '---\ntrust_tier: confluence\n---\nsynced\n'
    )
  }

  it('lists user-tier skills and team-knowledge references only', () => {
    seedUserAssets()
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: fakeGit().runner
    })
    expect(svc.pushable()).toEqual([
      { kind: 'skill', name: 'my-skill' },
      { kind: 'reference', name: 'team-tips.md' }
    ])
  })

  it('push branches from origin default, commits, pushes without force, opens a PR', async () => {
    seedClone()
    seedUserAssets()
    const calls: string[][] = []
    const git: Runner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      return ''
    }
    const gh: Runner = async (_c, args) => {
      calls.push(['gh', ...args])
      return 'https://github.com/acme/hivemind/pull/7'
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git, gh })
    const r = await svc.push('skill', 'my-skill', 'Add my-skill')
    expect(r).toEqual({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/7' })
    // the copy landed in the clone before commit
    expect(fs.existsSync(path.join(home, 'hivemind', 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
    const flat = calls.map((c) => c.join(' '))
    expect(flat.some((c) => c.startsWith('checkout -B argus/share-skill-my-skill-'))).toBe(true)
    expect(flat).toContain('add -A')
    expect(flat.some((c) => c.startsWith('push -u origin argus/share-'))).toBe(true)
    expect(flat.every((c) => !c.includes('--force'))).toBe(true)
    expect(flat.some((c) => c.startsWith('gh pr create'))).toBe(true)
    // clone restored to the default branch afterwards
    expect(flat[flat.length - 1]).toBe('checkout main')
  })

  it('push failures surface as { ok: false } and still restore the branch', async () => {
    seedClone()
    seedUserAssets()
    const calls: string[][] = []
    const git: Runner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      if (args[0] === 'push') throw new Error('remote rejected (non-fast-forward)')
      return ''
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git })
    const r = await svc.push('skill', 'my-skill', 'Add my-skill')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/remote rejected/)
    expect(calls[calls.length - 1]).toEqual(['checkout', 'main'])
  })

  it('pushPreview returns the user-tier content', () => {
    seedUserAssets()
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: fakeGit().runner
    })
    expect(svc.pushPreview('skill', 'my-skill')).toContain('# my-skill')
    expect(svc.pushPreview('reference', 'team-tips.md')).toContain('tips')
  })

  it('a successful push persists a receipt exposed via payload(); re-push overwrites', async () => {
    seedClone()
    seedUserAssets()
    const git: Runner = async (_c, args) => {
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      if (args[0] === 'rev-parse') return 'headsha'
      return ''
    }
    let pr = 'https://github.com/acme/hivemind/pull/7'
    const gh: Runner = async () => pr
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git, gh })

    await svc.push('skill', 'my-skill', 'Add my-skill')
    let receipt = (await svc.payload()).pushes['skill/my-skill']
    expect(receipt.prUrl).toBe('https://github.com/acme/hivemind/pull/7')
    expect(Date.parse(receipt.pushedAt)).not.toBeNaN()

    // persisted on disk: a fresh service over the same argusHome sees it
    const svc2 = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git, gh })
    expect((await svc2.payload()).pushes['skill/my-skill'].prUrl).toBe(receipt.prUrl)

    // last push wins
    pr = 'https://github.com/acme/hivemind/pull/8'
    await svc.push('skill', 'my-skill', 'Update my-skill')
    receipt = (await svc.payload()).pushes['skill/my-skill']
    expect(receipt.prUrl).toBe('https://github.com/acme/hivemind/pull/8')
  })

  it('reference receipts key as reference/<name>', async () => {
    seedClone()
    seedUserAssets()
    const git: Runner = async (_c, args) => {
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      if (args[0] === 'rev-parse') return 'headsha'
      return ''
    }
    const gh: Runner = async () => 'https://github.com/acme/hivemind/pull/9'
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git, gh })
    await svc.push('reference', 'team-tips.md', 'Add team-tips')
    expect((await svc.payload()).pushes['reference/team-tips.md'].prUrl).toBe(
      'https://github.com/acme/hivemind/pull/9'
    )
  })

  it('a failed push writes no receipt', async () => {
    seedClone()
    seedUserAssets()
    const git: Runner = async (_c, args) => {
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      if (args[0] === 'push') throw new Error('remote rejected')
      return ''
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git })
    const r = await svc.push('skill', 'my-skill', 'Add my-skill')
    expect(r.ok).toBe(false)
    expect((await svc.payload()).pushes).toEqual({})
  })
})

describe('reference keep-authorship', () => {
  function seedLocalRef(name: string, tier: string): void {
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'references', name),
      `---\ntrust_tier: ${tier}\n---\nmy local draft\n`
    )
  }

  it('install over a user-tier local copy preserves the tier and stays pushable', async () => {
    seedClone()
    seedLocalRef('hive-note.md', 'user')
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.install('reference', 'hive-note.md')
    const written = fs.readFileSync(path.join(home, 'references', 'hive-note.md'), 'utf8')
    expect(written).toContain('trust_tier: user')
    expect(written).not.toContain('trust_tier: hivemind')
    expect(written).toContain('source_repo: acme/hivemind')
    expect(written).toContain('source_commit: refsha')
    expect(written).toContain('# note') // upstream content won; only the tier survived
    expect(written).not.toContain('my local draft')
    expect(p.pushable).toContainEqual({ kind: 'reference', name: 'hive-note.md' })
  })

  it('install preserves team-knowledge but restamps confluence to hivemind', async () => {
    seedClone()
    seedLocalRef('hive-note.md', 'team-knowledge')
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.install('reference', 'hive-note.md')
    expect(fs.readFileSync(path.join(home, 'references', 'hive-note.md'), 'utf8')).toContain(
      'trust_tier: team-knowledge'
    )
    seedLocalRef('hive-note.md', 'confluence')
    await svc.install('reference', 'hive-note.md')
    expect(fs.readFileSync(path.join(home, 'references', 'hive-note.md'), 'utf8')).toContain(
      'trust_tier: hivemind'
    )
  })

  it('listItems exposes the local tier of installed references, null otherwise', async () => {
    seedClone()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    let p = await svc.payload()
    expect(p.items.find((i) => i.name === 'hive-note.md')?.localTier).toBeNull()
    expect(p.items.find((i) => i.name === 'hive-probe')?.localTier).toBeNull()
    p = await svc.install('reference', 'hive-note.md')
    expect(p.items.find((i) => i.name === 'hive-note.md')?.localTier).toBe('hivemind')
    seedLocalRef('hive-note.md', 'user')
    p = await svc.install('reference', 'hive-note.md')
    expect(p.items.find((i) => i.name === 'hive-note.md')?.localTier).toBe('user')
  })

  it('claimReference flips a hivemind reference to user tier, keeping provenance', async () => {
    seedClone()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.install('reference', 'hive-note.md')
    const p = await svc.claimReference('hive-note.md')
    const written = fs.readFileSync(path.join(home, 'references', 'hive-note.md'), 'utf8')
    expect(written).toContain('trust_tier: user')
    expect(written).toContain('source_repo: acme/hivemind')
    expect(written).toContain('source_commit: refsha')
    expect(written).toContain('# note')
    expect(p.pushable).toContainEqual({ kind: 'reference', name: 'hive-note.md' })
    expect(p.items.find((i) => i.name === 'hive-note.md')?.localTier).toBe('user')
  })

  it('claimReference rejects traversal, unknown, and non-hivemind names', async () => {
    seedClone()
    seedLocalRef('mine.md', 'user')
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await expect(svc.claimReference('../evil.md')).rejects.toThrow(/Invalid reference name/)
    await expect(svc.claimReference('a\\b.md')).rejects.toThrow(/Invalid reference name/)
    await expect(svc.claimReference('')).rejects.toThrow(/Invalid reference name/)
    await expect(svc.claimReference('ghost.md')).rejects.toThrow(/Not an installed HiveMind/)
    await expect(svc.claimReference('mine.md')).rejects.toThrow(/Not an installed HiveMind/)
  })
})

describe('check', () => {
  it('reports ok when git ls-remote succeeds against the clone URL', async () => {
    const calls: string[][] = []
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'org/hive',
      git: async (_cmd, args) => {
        calls.push(args)
        return 'abc\tHEAD'
      }
    })
    expect(await svc.check()).toEqual({ ok: true })
    expect(calls[0]).toEqual(['ls-remote', 'https://github.com/org/hive.git', 'HEAD'])
  })

  it('reports the git error when the repo is unreachable', async () => {
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'org/nope',
      git: async () => {
        throw new Error('repository not found')
      }
    })
    const r = await svc.check()
    expect(r).toEqual({ ok: false, error: 'repository not found' })
  })

  it('fails fast on a blank repo without shelling out', async () => {
    const svc = new HivemindService({
      argusHome: home,
      repo: () => '  ',
      git: async () => {
        throw new Error('must not be called')
      }
    })
    expect((await svc.check()).ok).toBe(false)
  })

  it('runs non-interactively with a bounded timeout so it can never prompt or hang', async () => {
    let seenOpts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } | undefined
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'org/hive',
      git: async (_cmd, _args, opts) => {
        seenOpts = opts
        return 'abc\tHEAD'
      }
    })
    expect(await svc.check()).toEqual({ ok: true })
    expect(seenOpts?.env?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(seenOpts?.env?.GCM_INTERACTIVE).toBe('never')
    expect(seenOpts?.timeoutMs).toBe(15000)
  })
})

describe('confluence subfolder references', () => {
  /** Adds references/confluence/<name> to the seeded clone (call seedClone() first). */
  function seedConfluenceRef(name = 'adasis.md', content = '# adasis distilled\n'): void {
    const dir = path.join(home, 'hivemind', 'references', 'confluence')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }

  it('listItems surfaces references/confluence/*.md as confluence/<basename>.md', async () => {
    seedClone()
    seedConfluenceRef()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.payload()
    const refs = p.items.filter((i) => i.kind === 'reference').map((i) => i.name)
    expect(refs).toContain('hive-note.md') // flat scan unchanged
    expect(refs).toContain('confluence/adasis.md')
    const item = p.items.find((i) => i.name === 'confluence/adasis.md')!
    expect(item.installed).toBe(false)
    expect(item.localTier).toBeNull()
  })

  it('other subdirectories under references/ stay invisible', async () => {
    seedClone()
    const dir = path.join(home, 'hivemind', 'references', 'drafts')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'wip.md'), '# wip\n')
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const names = (await svc.payload()).items.map((i) => i.name)
    expect(names).not.toContain('drafts/wip.md')
    expect(names).not.toContain('wip.md')
  })

  it('dot-prefixed .md files are not listed (install would reject them)', async () => {
    seedClone()
    seedConfluenceRef('.hidden.md', '# hidden\n')
    fs.writeFileSync(path.join(home, 'hivemind', 'references', '.flat-hidden.md'), '# hidden\n')
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const names = (await svc.payload()).items.map((i) => i.name)
    expect(names).not.toContain('confluence/.hidden.md')
    expect(names).not.toContain('.flat-hidden.md')
  })

  it('installed/localTier of a confluence item track the flattened local copy', async () => {
    seedClone()
    seedConfluenceRef()
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'references', 'adasis.md'),
      '---\ntrust_tier: confluence\n---\n# adasis distilled\n'
    )
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const item = (await svc.payload()).items.find((i) => i.name === 'confluence/adasis.md')!
    expect(item.installed).toBe(true)
    expect(item.localTier).toBe('confluence')
  })

  it('itemCommit/diff use the full in-clone relative path for confluence items', async () => {
    seedClone()
    seedConfluenceRef()
    const git = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: git.runner
    })
    await svc.payload()
    expect(
      git.calls.some((c) => c[0] === 'log' && c.includes('references/confluence/adasis.md'))
    ).toBe(true)
  })

  it('install flattens confluence/x.md to references/x.md and stamps confluence tier', async () => {
    seedClone()
    seedConfluenceRef()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.install('reference', 'confluence/adasis.md')
    expect(fs.existsSync(path.join(home, 'references', 'confluence'))).toBe(false) // no subfolder locally
    const written = fs.readFileSync(path.join(home, 'references', 'adasis.md'), 'utf8')
    expect(written).toContain('trust_tier: confluence')
    expect(written).toContain('source_repo: acme/hivemind')
    expect(written).toContain('source_commit: refsha')
    expect(written).toContain('# adasis distilled')
    const item = p.items.find((i) => i.name === 'confluence/adasis.md')!
    expect(item.installed).toBe(true)
    expect(item.installedCommit).toBe('refsha')
    expect(item.localTier).toBe('confluence')
    expect(item.updateAvailable).toBe(false)
  })

  it('confluence install restamps even a prior user-tier local copy (deliberate takeover)', async () => {
    seedClone()
    seedConfluenceRef()
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'references', 'adasis.md'),
      '---\ntrust_tier: user\n---\nmy local draft\n'
    )
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.install('reference', 'confluence/adasis.md')
    const written = fs.readFileSync(path.join(home, 'references', 'adasis.md'), 'utf8')
    expect(written).toContain('trust_tier: confluence')
    expect(written).not.toContain('my local draft')
  })

  it('install rejects traversal and non-confluence subfolder reference names', async () => {
    seedClone()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await expect(svc.install('reference', '../evil.md')).rejects.toThrow(/Invalid reference name/)
    await expect(svc.install('reference', 'confluence/../evil.md')).rejects.toThrow(
      /Invalid reference name/
    )
    await expect(svc.install('reference', 'drafts/wip.md')).rejects.toThrow(
      /Invalid reference name/
    )
    await expect(svc.install('reference', 'confluence\\x.md')).rejects.toThrow(
      /Invalid reference name/
    )
    await expect(svc.install('reference', 'confluence/.hidden.md')).rejects.toThrow(
      /Invalid reference name/
    )
    await expect(svc.install('reference', 'confluence/notes.txt')).rejects.toThrow(
      /Invalid reference name/
    )
  })

  it('a confluence-installed reference is un-claimable and un-pushable', async () => {
    seedClone()
    seedConfluenceRef()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.install('reference', 'confluence/adasis.md')
    // claim targets the flattened local name and must reject the confluence tier
    await expect(svc.claimReference('adasis.md')).rejects.toThrow(/Not an installed HiveMind/)
    expect(p.pushable).not.toContainEqual({ kind: 'reference', name: 'adasis.md' })
    expect(svc.pushable()).not.toContainEqual({ kind: 'reference', name: 'adasis.md' })
  })

  it('flat/confluence name collision: last install wins the file, pins stay per-item', async () => {
    seedClone() // seeds flat references/hive-note.md
    seedConfluenceRef('hive-note.md', '# distilled twin\n')
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const local = path.join(home, 'references', 'hive-note.md')

    let p = await svc.install('reference', 'hive-note.md')
    expect(fs.readFileSync(local, 'utf8')).toContain('trust_tier: hivemind')

    p = await svc.install('reference', 'confluence/hive-note.md')
    expect(fs.readFileSync(local, 'utf8')).toContain('trust_tier: confluence')
    expect(fs.readFileSync(local, 'utf8')).toContain('# distilled twin')

    // re-installing the flat twin takes the file back (prior confluence tier is not preserved)
    p = await svc.install('reference', 'hive-note.md')
    expect(fs.readFileSync(local, 'utf8')).toContain('trust_tier: hivemind')

    // both items keep their own pin, and both report installed (same flat file)
    const flat = p.items.find((i) => i.name === 'hive-note.md')!
    const conf = p.items.find((i) => i.name === 'confluence/hive-note.md')!
    expect(flat.installed).toBe(true)
    expect(conf.installed).toBe(true)
    expect(flat.installedCommit).toBe('refsha')
    expect(conf.installedCommit).toBe('refsha')
  })
})
