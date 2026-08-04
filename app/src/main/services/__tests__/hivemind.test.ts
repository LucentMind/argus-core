import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  HivemindService,
  cloneUrl,
  normalizeForCompare,
  resolvedTier,
  sameContents,
  type Runner
} from '../hivemind'
import { parseAuthorship } from '../../../shared/authorship'

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

  it('sync heals a clone parked on a share branch before pulling', async () => {
    // The old `push` self-healed via a `checkout <defaultBranch>` in its `finally`; the
    // worktree rewrite never touches the clone's HEAD at all, so a clone left parked (by a
    // killed process or a failed cleanup) never recovers on its own. `sync()` must restore
    // the default branch before pulling, or every HEAD-relative read stays poisoned forever.
    seedClone()
    const calls: string[][] = []
    const runner: Runner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'remote') return 'https://github.com/acme/hivemind.git'
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD')
        return 'argus/share-skill-x-1234567890'
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'origin/HEAD')
        return 'origin/main'
      if (args[0] === 'rev-parse') return 'headsha'
      if (args[0] === 'log') return 'itemsha'
      return ''
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.sync()
    expect(calls.some((c) => c[0] === 'checkout' && c[1] === 'main')).toBe(true)
    // the heal must happen before the pull, or a parked HEAD advances the wrong branch
    const checkoutIdx = calls.findIndex((c) => c[0] === 'checkout')
    const pullIdx = calls.findIndex((c) => c[0] === 'pull')
    expect(checkoutIdx).toBeGreaterThanOrEqual(0)
    expect(pullIdx).toBeGreaterThan(checkoutIdx)
    expect(p.state).toBe('ready')
  })

  it('sync issues no checkout when HEAD is already on the default branch', async () => {
    seedClone()
    const calls: string[][] = []
    const runner: Runner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'remote') return 'https://github.com/acme/hivemind.git'
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') return 'main'
      if (args[0] === 'rev-parse') return 'headsha'
      if (args[0] === 'log') return 'itemsha'
      return ''
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.sync()
    expect(calls.some((c) => c[0] === 'checkout')).toBe(false)
    // short-circuits before even asking for the default branch when HEAD isn't parked
    expect(calls.some((c) => c[0] === 'rev-parse' && c.includes('origin/HEAD'))).toBe(false)
  })

  it('sync issues no checkout when HEAD is on an unrelated non-default branch', async () => {
    // Distinct from "HEAD is already the default branch": this proves the guard is keyed on
    // the argus/share- prefix, not on head !== defaultBranch — a deliberate checkout of some
    // other branch (e.g. the user inspecting their own work) must survive sync() untouched.
    seedClone()
    const calls: string[][] = []
    const runner: Runner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'remote') return 'https://github.com/acme/hivemind.git'
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD')
        return 'feature/mine'
      if (args[0] === 'rev-parse') return 'headsha'
      if (args[0] === 'log') return 'itemsha'
      return ''
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.sync()
    expect(calls.some((c) => c[0] === 'checkout')).toBe(false)
  })

  it('sync does not probe or heal HEAD on a fresh clone (nothing to park)', async () => {
    const calls: string[][] = []
    const runner: Runner = async (_c, args) => {
      calls.push(args)
      return ''
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.sync()
    expect(calls.some((c) => c[0] === 'checkout')).toBe(false)
    expect(calls[0]).toEqual([
      'clone',
      'https://github.com/acme/hivemind.git',
      path.join(home, 'hivemind')
    ])
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
    let copyExistedAtCommit = false
    const git: Runner = async (_c, args, opts) => {
      calls.push(args)
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      // Positive assertion that the copy actually lands somewhere: a `push` that skipped
      // `cpSync` entirely would still pass every other assertion in this test, so snapshot
      // whether the file exists in the worktree at the moment `commit` runs.
      if (args[0] === 'commit') {
        copyExistedAtCommit = fs.existsSync(
          path.join(opts?.cwd ?? '', 'skills', 'my-skill', 'SKILL.md')
        )
      }
      return ''
    }
    const gh: Runner = async (_c, args) => {
      calls.push(['gh', ...args])
      return 'https://github.com/acme/hivemind/pull/7'
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git, gh })
    const r = await svc.push('skill', 'my-skill', 'Add my-skill')
    expect(r).toEqual({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/7' })
    expect(copyExistedAtCommit).toBe(true)
    // the copy never lands in the shared clone itself — only in the throwaway worktree,
    // which is gone by the time push returns
    expect(fs.existsSync(path.join(home, 'hivemind', 'skills', 'my-skill'))).toBe(false)
    const flat = calls.map((c) => c.join(' '))
    expect(flat.some((c) => c.startsWith('worktree add -b argus/share-skill-my-skill-'))).toBe(true)
    expect(flat).toContain('add -A')
    expect(flat.some((c) => c.startsWith('push -u origin argus/share-'))).toBe(true)
    // never force-pushes (the worktree-removal step below legitimately carries its own
    // unrelated --force, so scope this check to the `push` subcommand specifically)
    expect(calls.every((a) => a[0] !== 'push' || !a.includes('--force'))).toBe(true)
    expect(flat.some((c) => c.startsWith('gh pr create'))).toBe(true)
    // the throwaway worktree is removed afterwards; the clone's HEAD was never moved
    expect(flat[flat.length - 1]).toMatch(/^worktree remove --force /)
    expect(calls.filter((a) => a[0] === 'checkout')).toEqual([])
  })

  it('push branches from the pinned commit when the item came from HiveMind', async () => {
    seedClone()
    seedUserAssets()
    // pin my-skill at an older commit, as `install` would have.
    // (Written directly rather than read-modify-write: nothing has called
    // store.write() yet at this point, so the state file doesn't exist on disk.)
    const statePath = path.join(home, 'config', 'hivemind-state.json')
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        lastSynced: null,
        skills: { 'my-skill': 'pinnedsha' },
        references: {},
        pushes: {}
      })
    )
    const calls: string[][] = []
    const git: Runner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      return ''
    }
    const gh: Runner = async (_c, args) => {
      calls.push(['gh', ...args])
      return 'https://github.com/acme/hivemind/pull/9'
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git, gh })
    const r = await svc.push('skill', 'my-skill', 'Improve my-skill')
    expect(r.ok).toBe(true)
    const flat = calls.map((c) => c.join(' '))
    // branch cut from the pin, NOT origin/main — otherwise the PR reverts X→HEAD
    expect(
      flat.some((c) => /^worktree add -b argus\/share-skill-my-skill-\d+ \S+ pinnedsha$/.test(c))
    ).toBe(true)
    expect(flat.every((c) => !/^worktree add -b \S+ \S+ origin\/main$/.test(c))).toBe(true)
    // the throwaway worktree is removed afterwards; the clone's HEAD was never moved
    expect(flat[flat.length - 1]).toMatch(/^worktree remove --force /)
  })

  it('push still branches from origin default for a locally authored item', async () => {
    seedClone()
    seedUserAssets()
    const calls: string[][] = []
    const git: Runner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      return ''
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git })
    await svc.push('skill', 'my-skill', 'Add my-skill')
    const flat = calls.map((c) => c.join(' '))
    expect(
      flat.some((c) => /^worktree add -b argus\/share-skill-my-skill-\d+ \S+ origin\/main$/.test(c))
    ).toBe(true)
  })

  it("push branches from origin default when the pin is an empty string, not `git worktree add -b <branch> <tree> ''`", async () => {
    // `pinFor` used `?? null`, which only substitutes null/undefined — an empty-string pin
    // (falsy but not nullish) sailed through to the branch-from-pin call site's `?? fallback`
    // unchanged, producing a bogus base arg (originally `checkout -B <branch> ''`, now
    // `worktree add -b <branch> <tree> ''`).
    seedClone()
    seedUserAssets()
    const statePath = path.join(home, 'config', 'hivemind-state.json')
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(
      statePath,
      JSON.stringify({ lastSynced: null, skills: { 'my-skill': '' }, references: {}, pushes: {} })
    )
    const calls: string[][] = []
    const git: Runner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      return ''
    }
    const gh: Runner = async (_c, args) => {
      calls.push(['gh', ...args])
      return 'https://github.com/acme/hivemind/pull/11'
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git, gh })
    const r = await svc.push('skill', 'my-skill', 'Add my-skill')
    expect(r).toEqual({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/11' })
    const flat = calls.map((c) => c.join(' '))
    expect(
      flat.some((c) => /^worktree add -b argus\/share-skill-my-skill-\d+ \S+ origin\/main$/.test(c))
    ).toBe(true)
    // the bug this guards against: a trailing-empty-arg base (`worktree add -b <branch> <tree> `)
    expect(flat.every((c) => !/^worktree add -b \S+ \S+ $/.test(c))).toBe(true)
  })

  it('push failures surface as { ok: false } and still remove the worktree', async () => {
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
    expect(calls[calls.length - 1].slice(0, 3)).toEqual(['worktree', 'remove', '--force'])
    expect(calls.filter((a) => a[0] === 'checkout')).toEqual([])
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

  it('a failed push writes no receipt and preserves existing ones', async () => {
    seedClone()
    seedUserAssets()
    // First: successful push to seed a receipt
    const successGit: Runner = async (_c, args) => {
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      if (args[0] === 'rev-parse') return 'headsha'
      return ''
    }
    const successGh: Runner = async () => 'https://github.com/acme/hivemind/pull/7'
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: successGit,
      gh: successGh
    })
    await svc.push('skill', 'my-skill', 'Add my-skill')
    const receipt = (await svc.payload()).pushes['skill/my-skill']
    expect(receipt.prUrl).toBe('https://github.com/acme/hivemind/pull/7')

    // Then: failed push with a different service instance over the same argusHome
    const failGit: Runner = async (_c, args) => {
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main'
      if (args[0] === 'push') throw new Error('remote rejected')
      return ''
    }
    const svc2 = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: failGit })
    const r = await svc2.push('skill', 'my-skill', 'Update my-skill')
    expect(r.ok).toBe(false)
    // Receipt from first push must still be there
    expect((await svc2.payload()).pushes['skill/my-skill'].prUrl).toBe(
      'https://github.com/acme/hivemind/pull/7'
    )
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

  it('install over a user-tier local copy rejects without acknowledgement, then preserves the tier and stays pushable', async () => {
    seedClone()
    seedLocalRef('hive-note.md', 'user')
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })

    // No pin yet — a hand-written local file predating any HiveMind install is exactly the
    // data-loss path the divergence guard now covers, so the first install must refuse.
    await expect(svc.install('reference', 'hive-note.md')).rejects.toThrow(
      /differs from the version that would be installed/i
    )
    expect(fs.readFileSync(path.join(home, 'references', 'hive-note.md'), 'utf8')).toContain(
      'my local draft'
    )

    const p = await svc.install('reference', 'hive-note.md', { overwriteLocalEdits: true })
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
    // No pin yet, and the hand-seeded draft differs from HEAD — the unified divergence
    // guard now covers first installs too, so acknowledge it to keep exercising tier-stamping.
    await svc.install('reference', 'hive-note.md', { overwriteLocalEdits: true })
    expect(fs.readFileSync(path.join(home, 'references', 'hive-note.md'), 'utf8')).toContain(
      'trust_tier: team-knowledge'
    )
    seedLocalRef('hive-note.md', 'confluence')
    // Overwriting the hand-seeded local draft is exactly what the divergence guard exists
    // to gate; acknowledge it so this test can keep exercising the tier-stamping logic.
    await svc.install('reference', 'hive-note.md', { overwriteLocalEdits: true })
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
    // As above: this hand-seeded draft diverges from the pin, so acknowledge the overwrite.
    p = await svc.install('reference', 'hive-note.md', { overwriteLocalEdits: true })
    expect(p.items.find((i) => i.name === 'hive-note.md')?.localTier).toBe('user')
  })

  it('claimReference flips a hivemind reference to user tier, keeping provenance', async () => {
    seedClone()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.install('reference', 'hive-note.md')
    const p = await svc.claimReference('hive-note.md', null)
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
    await expect(svc.claimReference('../evil.md', null)).rejects.toThrow(/Invalid reference name/)
    await expect(svc.claimReference('a\\b.md', null)).rejects.toThrow(/Invalid reference name/)
    await expect(svc.claimReference('', null)).rejects.toThrow(/Invalid reference name/)
    await expect(svc.claimReference('ghost.md', null)).rejects.toThrow(/Not an installed HiveMind/)
    await expect(svc.claimReference('mine.md', null)).rejects.toThrow(/Not an installed HiveMind/)
  })
})

describe('claim records the claimer without taking the byline', () => {
  const me = { name: 'Jiawei Han', email: 'jiawiehan@gmail.com' }

  it('keeps an upstream author and appends the claimer', async () => {
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const file = path.join(home, 'references', 'topic.md')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      '---\ntitle: T\ntrust_tier: hivemind\nauthor: Alex Chen <alex@example.test>\norigin: authored\n---\nbody\n'
    )
    await svc.claimReference('topic.md', me)

    const raw = fs.readFileSync(file, 'utf8')
    const a = parseAuthorship(raw)
    expect(raw).toContain('trust_tier: user')
    expect(a.author).toBe('Alex Chen <alex@example.test>')
    expect(a.origin).toBe('authored')
    expect(a.contributors.map((c) => c.email)).toEqual(['jiawiehan@gmail.com'])
  })

  it('leaves author empty when the upstream file had none', async () => {
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const file = path.join(home, 'references', 'topic.md')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '---\ntitle: T\ntrust_tier: hivemind\n---\nbody\n')
    await svc.claimReference('topic.md', me)

    const a = parseAuthorship(fs.readFileSync(file, 'utf8'))
    expect(a.author).toBeNull()
    expect(a.contributors.map((c) => c.email)).toEqual(['jiawiehan@gmail.com'])
  })

  it('install passes an incoming trail through untouched', async () => {
    // installing is not contributing — see the spec's §7 table
    seedClone()
    const dest = path.join(home, 'hivemind', 'references', 'topic.md')
    fs.writeFileSync(
      dest,
      '---\ntitle: T\nauthor: Alex Chen <alex@example.test>\norigin: authored\ncontributors:\n  - Alex Chen <alex@example.test> 2026-07-01\n---\nbody\n'
    )
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'refsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    await svc.install('reference', 'topic.md')

    const a = parseAuthorship(fs.readFileSync(path.join(home, 'references', 'topic.md'), 'utf8'))
    expect(a.author).toBe('Alex Chen <alex@example.test>')
    expect(a.contributors).toEqual([
      { name: 'Alex Chen', email: 'alex@example.test', date: '2026-07-01' }
    ])
  })
})

describe('author on browse items', () => {
  it('a skill item carries the author read from the clone', async () => {
    const clone = seedClone()
    fs.writeFileSync(
      path.join(clone, 'skills', 'hive-probe', 'SKILL.md'),
      '---\nname: hive-probe\ndescription: probe skill from the hive\nauthor: Alex Chen <alex@example.test>\n---\n# hive-probe\n'
    )
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'itemsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.payload()
    expect(p.items.find((i) => i.name === 'hive-probe')!.author).toBe(
      'Alex Chen <alex@example.test>'
    )
  })

  it('a reference item carries the author read from the clone', async () => {
    const clone = seedClone()
    fs.writeFileSync(
      path.join(clone, 'references', 'hive-note.md'),
      '---\nauthor: Alex Chen <alex@example.test>\n---\n# note\n'
    )
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'itemsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.payload()
    expect(p.items.find((i) => i.name === 'hive-note.md')!.author).toBe(
      'Alex Chen <alex@example.test>'
    )
  })

  it('author is null when absent from either frontmatter', async () => {
    seedClone()
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'itemsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const p = await svc.payload()
    expect(p.items.find((i) => i.name === 'hive-probe')!.author).toBeNull()
    expect(p.items.find((i) => i.name === 'hive-note.md')!.author).toBeNull()
  })

  it('reads a skill item SKILL.md exactly once for description+author together', async () => {
    const clone = seedClone()
    const skillMd = path.join(clone, 'skills', 'hive-probe', 'SKILL.md')
    const { runner } = fakeGit({ 'rev-parse': 'headsha', log: 'itemsha' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git: runner })
    const spy = vi.spyOn(fs, 'readFileSync')
    await svc.payload()
    const reads = spy.mock.calls.filter((call) => call[0] === skillMd)
    spy.mockRestore()
    expect(reads).toHaveLength(1)
  })

  it('a reference file that vanishes between listing and reading degrades to author: null instead of throwing', async () => {
    const clone = seedClone()
    const refPath = path.join(clone, 'references', 'hive-note.md')
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: async (_cmd, args) => {
        // itemCommit runs after readdirSync already found the entry but before listItems
        // reads its content — deleting it here simulates the file vanishing in that window.
        if (args.includes('references/hive-note.md')) fs.rmSync(refPath, { force: true })
        if (args[0] === 'rev-parse') return 'headsha'
        if (args[0] === 'log') return 'itemsha'
        return ''
      }
    })
    const p = await svc.payload()
    expect(p.items.find((i) => i.name === 'hive-note.md')!.author).toBeNull()
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
    // No pin yet for this confluence name, and the hand-seeded local file differs from
    // HEAD — the unified divergence guard now covers this first-install case too.
    await svc.install('reference', 'confluence/adasis.md', { overwriteLocalEdits: true })
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
    await expect(svc.claimReference('adasis.md', null)).rejects.toThrow(/Not an installed HiveMind/)
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

    // No pin yet for the confluence name, and the shared file currently holds the flat
    // twin's content, which differs from HEAD of the confluence path — acknowledge the
    // takeover to keep testing pin/tier bookkeeping.
    p = await svc.install('reference', 'confluence/hive-note.md', { overwriteLocalEdits: true })
    expect(fs.readFileSync(local, 'utf8')).toContain('trust_tier: confluence')
    expect(fs.readFileSync(local, 'utf8')).toContain('# distilled twin')

    // re-installing the flat twin takes the file back (prior confluence tier is not preserved).
    // The shared destination currently holds the confluence twin's content, which differs
    // from the flat item's own pin — the guard fires on that difference, not because the
    // user edited anything, and this test acknowledges the overwrite to proceed.
    p = await svc.install('reference', 'hive-note.md', { overwriteLocalEdits: true })
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

describe('normalizeForCompare', () => {
  it('ignores the three install stamps but keeps other frontmatter', () => {
    const stamped =
      '---\ntags: ops\ntrust_tier: user\nsource_repo: acme/hive\nsource_commit: abc123\n---\n# note\n'
    const bare = '---\ntags: ops\n---\n# note\n'
    expect(normalizeForCompare(stamped)).toBe(normalizeForCompare(bare))
  })

  it('treats a changed non-stamp frontmatter field as a difference', () => {
    const a = '---\ntags: ops\ntrust_tier: user\n---\n# note\n'
    const b = '---\ntags: security\ntrust_tier: user\n---\n# note\n'
    expect(normalizeForCompare(a)).not.toBe(normalizeForCompare(b))
  })

  it('treats a changed body as a difference', () => {
    const a = '---\ntrust_tier: user\n---\n# note v1\n'
    const b = '---\ntrust_tier: user\n---\n# note v2\n'
    expect(normalizeForCompare(a)).not.toBe(normalizeForCompare(b))
  })

  it('is line-ending agnostic', () => {
    expect(normalizeForCompare('---\ntags: ops\n---\n# note\n')).toBe(
      normalizeForCompare('---\r\ntags: ops\r\n---\r\n# note\r\n')
    )
  })

  it('handles a file with no frontmatter at all', () => {
    expect(normalizeForCompare('# note\n')).toBe(normalizeForCompare('# note'))
  })

  it('equates a pristine install with its frontmatter-less upstream blob', () => {
    // install() stamps a file that upstream stores with no frontmatter at all —
    // the stripped result must not keep a stray `---` the upstream side lacks
    const upstream = '# note\n'
    const installed =
      '---\ntrust_tier: hivemind\nsource_repo: acme/hive\nsource_commit: abc123\n---\n# note\n'
    expect(normalizeForCompare(installed)).toBe(normalizeForCompare(upstream))
  })
})

/**
 * A service whose clone is seeded and whose reference is installed through the real
 * `install()`, so the pin on disk is genuine — the state file lives under
 * `config/hivemind-state.json` and must not be hand-written.
 *
 * The fake git serves a sha for the commit lookup (`git log -1 --format=%H`) and distinct
 * blobs for `git show <pin>:...` vs `git show HEAD:...`. `localEdit`, when given, replaces
 * the installed file afterwards to simulate an unpushed edit.
 */
async function installedReference(opts: {
  pinned: string
  head: string
  localEdit?: string
}): Promise<HivemindService> {
  seedClone()
  const svc = new HivemindService({
    argusHome: home,
    repo: () => 'acme/hivemind',
    git: async (_cmd, args) => {
      if (args[0] === 'log') return 'pinsha'
      if (args[0] === 'show') return String(args[1]).startsWith('HEAD:') ? opts.head : opts.pinned
      return ''
    }
  })
  await svc.install('reference', 'hive-note.md')
  if (opts.localEdit !== undefined)
    fs.writeFileSync(path.join(home, 'references', 'hive-note.md'), opts.localEdit)
  return svc
}

describe('localDivergence', () => {
  it('is not diverged for a pristine copy that only differs by install stamps', async () => {
    // seedClone() writes `# note\n`; install() adds three stamps the pinned blob lacks
    const svc = await installedReference({ pinned: '# note\n', head: '# note v2\n' })
    expect((await svc.localDivergence('hive-note.md')).diverged).toBe(false)
  })

  it('is not diverged when the local text already equals HEAD (your PR merged)', async () => {
    const svc = await installedReference({
      pinned: '# note\n',
      head: '# note v2\n',
      localEdit: '---\ntrust_tier: user\nsource_commit: pinsha\n---\n# note v2\n'
    })
    expect((await svc.localDivergence('hive-note.md')).diverged).toBe(false)
  })

  it('is diverged when the local text matches neither the pin nor HEAD', async () => {
    const svc = await installedReference({
      pinned: '# note\n',
      head: '# note v2\n',
      localEdit: '---\ntrust_tier: user\nsource_commit: pinsha\n---\n# note\nMY EDIT\n'
    })
    expect((await svc.localDivergence('hive-note.md')).diverged).toBe(true)
  })

  it('reports not-diverged when there is no local file at all, regardless of pin', async () => {
    // A first install with nothing in the way must proceed normally — no file means the
    // guard returns before it ever needs to shell out to git.
    seedClone()
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: async () => {
        throw new Error('must not be called: no local file means no divergence check')
      }
    })
    expect(await svc.localDivergence('hive-note.md')).toEqual({
      diverged: false,
      diff: '',
      tierChange: null
    })
  })

  it('with no pin, a local file that differs from HEAD is diverged (first install over a hand-written file)', async () => {
    // No pin exists yet for this name, so the guard falls back to comparing against HEAD
    // alone — a hand-written references/hive-note.md predating any HiveMind install must
    // not be silently destroyed by the first install.
    seedClone()
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    fs.writeFileSync(path.join(home, 'references', 'hive-note.md'), '# my own notes\n')
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: async (_cmd, args) => (args[0] === 'show' ? '# note\n' : '')
    })
    expect((await svc.localDivergence('hive-note.md')).diverged).toBe(true)
  })

  it('with no pin, a local file that already equals HEAD is not diverged', async () => {
    seedClone()
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    fs.writeFileSync(path.join(home, 'references', 'hive-note.md'), '# note\n')
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: async (_cmd, args) => (args[0] === 'show' ? '# note\n' : '')
    })
    expect(await svc.localDivergence('hive-note.md')).toEqual({
      diverged: false,
      diff: '',
      // The file predates any HiveMind install and carries no trust_tier at all — installing
      // would still stamp it `hivemind`, independent of the content match.
      tierChange: { from: '', to: 'hivemind' }
    })
  })

  it('fails open (not-diverged) when a pin exists but git cannot read the blobs', async () => {
    await installedReference({
      pinned: '# note\n',
      head: '# note v2\n',
      localEdit: '# something else entirely\n'
    })
    // a second service over the same ARGUS_HOME — the pin is on disk, but git now fails.
    // A pinned copy came from the hive and can be re-downloaded, so a check that cannot
    // run must not block the update.
    const broken = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: async () => {
        throw new Error('fatal: bad object')
      }
    })
    expect(await broken.localDivergence('hive-note.md')).toEqual({
      diverged: false,
      diff: '',
      // The local edit overwrote the file wholesale, dropping the trust_tier install() had
      // stamped — install would restamp it `hivemind`, independent of the failed git check.
      tierChange: { from: '', to: 'hivemind' }
    })
  })

  it('the divergence diff never claims the user is losing their authorship stamp', async () => {
    // The existing 'is diverged when...' test above only asserts on `.diverged`, so nothing
    // catches a diff whose *content* is false. A raw-vs-raw diff would show `-trust_tier:
    // user` and `-source_commit: pinsha` as deletions — that's not something the user typed
    // and not something install() actually destroys (it re-stamps trust_tier itself), so the
    // rendered diff must not mention it, while still showing the user's real edit.
    //
    // `fakeGit` doesn't implement `diff --no-index`'s real exit-1-with-stdout behaviour, so
    // this test supplies its own runner: on the `--no-index` call it reads back whatever
    // `noIndexDiff` actually wrote to the `mine/` file in its temp dir and rejects with that
    // as `.stdout`, the same shape a real `git diff --no-index` failure carries. That proves
    // what content reached the diff, not just that the boolean came back true.
    seedClone()
    const pinned = '# note\n'
    const head = '# note v2\n'
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: async (_cmd, args, opts) => {
        if (args[0] === 'log') return 'pinsha'
        if (args[0] === 'show') return String(args[1]).startsWith('HEAD:') ? head : pinned
        if (args[0] === 'diff' && args.includes('--no-index')) {
          const mineRel = args[args.length - 2]
          const content = fs.readFileSync(path.join(opts!.cwd!, mineRel), 'utf8')
          const err = new Error('files differ') as Error & { stdout?: string }
          err.stdout = content
          throw err
        }
        return ''
      }
    })
    await svc.install('reference', 'hive-note.md')
    fs.writeFileSync(
      path.join(home, 'references', 'hive-note.md'),
      '---\ntrust_tier: user\nsource_commit: pinsha\n---\n# note\nMY EDIT\n'
    )
    const d = await svc.localDivergence('hive-note.md')
    expect(d.diverged).toBe(true)
    expect(d.diff).not.toContain('trust_tier')
    expect(d.diff).not.toContain('source_commit')
    expect(d.diff).toContain('MY EDIT')
  })

  it('fails closed (diverged, no diff) when there is no pin and git cannot read the blobs', async () => {
    // No pin exists for this name — a hand-written references/hive-note.md the app has
    // never touched. A failed check here means silent, irreversible loss of content that
    // exists nowhere else, so the fallback must refuse rather than wave the install through.
    seedClone()
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    fs.writeFileSync(path.join(home, 'references', 'hive-note.md'), '# my own notes\n')
    const broken = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: async () => {
        throw new Error('fatal: bad object')
      }
    })
    expect(await broken.localDivergence('hive-note.md')).toEqual({
      diverged: true,
      diff: '',
      // No frontmatter on the hand-written file — install would stamp it `hivemind`.
      tierChange: { from: '', to: 'hivemind' }
    })
  })
})

describe('install() and unpushed local edits', () => {
  const diverged = (): Promise<HivemindService> =>
    installedReference({
      pinned: '# note\n',
      head: '# note v2\n',
      localEdit: '---\ntrust_tier: user\nsource_commit: pinsha\n---\n# note\nMY EDIT\n'
    })

  it('refuses to overwrite a diverged local copy without an explicit acknowledgement', async () => {
    const svc = await diverged()
    await expect(svc.install('reference', 'hive-note.md')).rejects.toThrow(
      /differs from the version that would be installed/i
    )
    expect(fs.readFileSync(path.join(home, 'references', 'hive-note.md'), 'utf8')).toContain(
      'MY EDIT'
    )
  })

  it('overwrites when the caller acknowledges, and keeps the authorship stamp', async () => {
    const svc = await diverged()
    await svc.install('reference', 'hive-note.md', { overwriteLocalEdits: true })
    const after = fs.readFileSync(path.join(home, 'references', 'hive-note.md'), 'utf8')
    expect(after).not.toContain('MY EDIT')
    expect(after).toContain('trust_tier: user')
  })

  it('does not gate skills', async () => {
    const svc = await diverged()
    await svc.install('skill', 'hive-probe')
    // Assert the skill actually landed, not just that the call resolved: a bare
    // `resolves.toBeDefined()` would still pass even if install silently failed to write
    // the file, so check the file and its content directly.
    const dest = path.join(home, 'skills-hivemind', 'hive-probe', 'SKILL.md')
    expect(fs.existsSync(dest)).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toContain('probe skill from the hive')
  })
})

describe('push keeps the shared clone checked out', () => {
  /** A fake git that satisfies push's reads and records every call, cwd included. */
  function pushRunner(): {
    runner: Runner
    calls: string[][]
    cwds: (string | undefined)[]
  } {
    const calls: string[][] = []
    const cwds: (string | undefined)[] = []
    const runner: Runner = async (_cmd, args, opts) => {
      calls.push(args)
      cwds.push(opts?.cwd)
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'origin/main'
      return ''
    }
    return { runner, calls, cwds }
  }

  function seedUserSkill(): void {
    fs.mkdirSync(path.join(home, 'skills-user', 'my-skill'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'skills-user', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: mine\n---\n# my-skill\n'
    )
  }

  it('never issues a checkout against the clone', async () => {
    seedClone()
    seedUserSkill()
    const { runner, calls } = pushRunner()
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: runner,
      gh: async () => 'https://github.com/acme/hivemind/pull/9'
    })
    await svc.push('skill', 'my-skill', 'Add my-skill')
    // The structural guarantee: HEAD-safety comes from never moving it, not from moving it back.
    expect(calls.filter((a) => a[0] === 'checkout')).toEqual([])
  })

  it('prunes stale registrations before adding, and removes the worktree after', async () => {
    seedClone()
    seedUserSkill()
    const { runner, calls } = pushRunner()
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: runner,
      gh: async () => 'https://github.com/acme/hivemind/pull/9'
    })
    await svc.push('skill', 'my-skill', 'Add my-skill')
    const verbs = calls.filter((a) => a[0] === 'worktree').map((a) => a[1])
    expect(verbs).toEqual(['prune', 'add', 'remove'])
  })

  it('removes the worktree even when the PR step fails', async () => {
    seedClone()
    seedUserSkill()
    const { runner, calls } = pushRunner()
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: runner,
      gh: async () => {
        throw new Error('gh: not authenticated')
      }
    })
    const r = await svc.push('skill', 'my-skill', 'Add my-skill')
    expect(r.ok).toBe(false)
    expect(calls.filter((a) => a[0] === 'worktree' && a[1] === 'remove').length).toBe(1)
    expect(calls.filter((a) => a[0] === 'checkout')).toEqual([])
  })

  it('runs add, commit, and push in the worktree, not the clone', async () => {
    seedClone()
    seedUserSkill()
    const { runner, calls, cwds } = pushRunner()
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: runner,
      gh: async () => 'https://github.com/acme/hivemind/pull/9'
    })
    await svc.push('skill', 'my-skill', 'Add my-skill')
    const clone = path.join(home, 'hivemind')
    const cwdOf = (verb: string): string | undefined => cwds[calls.findIndex((a) => a[0] === verb)]
    const addCwd = cwdOf('add')
    const commitCwd = cwdOf('commit')
    const pushCwd = cwdOf('push')
    // If any of these regressed back to running in the clone, the whole point of the
    // worktree rewrite — that the clone's HEAD/working tree never moves — would be silently
    // undone even though `checkout` is never called.
    expect(addCwd).toBeDefined()
    expect(addCwd).not.toBe(clone)
    expect(commitCwd).toBeDefined()
    expect(commitCwd).not.toBe(clone)
    expect(pushCwd).toBeDefined()
    expect(pushCwd).not.toBe(clone)
  })

  it('a worktree-removal failure does not turn a successful push into a failure', async () => {
    seedClone()
    seedUserSkill()
    const { runner, calls } = pushRunner()
    const flakyRunner: Runner = async (cmd, args, opts) => {
      // Simulate a routine Windows cleanup failure (AV/indexer still holding a handle
      // right after `worktree add`'s directory was released).
      if (args[0] === 'worktree' && args[1] === 'remove') {
        calls.push(args)
        throw new Error('EBUSY: resource busy or locked')
      }
      return runner(cmd, args, opts)
    }
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: flakyRunner,
      gh: async () => 'https://github.com/acme/hivemind/pull/9'
    })
    const r = await svc.push('skill', 'my-skill', 'Add my-skill')
    expect(r).toEqual({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/9' })
    expect(calls.some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(true)
  })
})

describe('shadowedByUser', () => {
  it('is true for a skill with a skills-user copy and false without one', async () => {
    seedClone()
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: async () => ''
    })
    expect((await svc.payload()).items.find((i) => i.name === 'hive-probe')?.shadowedByUser).toBe(
      false
    )

    fs.mkdirSync(path.join(home, 'skills-user', 'hive-probe'), { recursive: true })
    fs.writeFileSync(path.join(home, 'skills-user', 'hive-probe', 'SKILL.md'), '# fork\n')
    expect((await svc.payload()).items.find((i) => i.name === 'hive-probe')?.shadowedByUser).toBe(
      true
    )
  })

  it('is always false for references', async () => {
    seedClone()
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: async () => ''
    })
    expect((await svc.payload()).items.find((i) => i.name === 'hive-note.md')?.shadowedByUser).toBe(
      false
    )
  })
})

describe('authorship is app-managed, not a local edit', () => {
  it('normalizeForCompare drops the authorship trail without orphaning its list items', () => {
    const upstream = ['---', 'title: T', 'tags: [a]', '---', '# body', ''].join('\n')
    const claimed = [
      '---',
      'title: T',
      'tags: [a]',
      'trust_tier: user',
      'author: Priya Nandakumar <priya@example.test>',
      'origin: authored',
      'contributors:',
      '  - Priya Nandakumar <priya@example.test> 2026-07-11',
      '  - Jiawei Han <jiawiehan@gmail.com> 2026-07-30',
      '---',
      '# body',
      ''
    ].join('\n')
    // identical text either side of a claim: the claim must not read as an unpushed edit
    expect(normalizeForCompare(claimed)).toBe(normalizeForCompare(upstream))
    // and the contributor items must not survive as orphaned top-level list lines
    expect(normalizeForCompare(claimed)).not.toMatch(/^\s*-\s/m)
    expect(normalizeForCompare(claimed)).toContain('tags: [a]')
  })

  it('still reports a real edit as a difference', () => {
    const upstream = '---\ntitle: T\n---\n# body\n'
    const edited = '---\ntitle: T\nauthor: A <a@example.test>\n---\n# body\n\nMY PARAGRAPH\n'
    expect(normalizeForCompare(edited)).not.toBe(normalizeForCompare(upstream))
  })
})

describe('resolvedTier', () => {
  it('force-stamps confluence for a confluence/ name, overriding a pushable prior tier', () => {
    expect(resolvedTier('confluence/x.md', 'user')).toBe('confluence')
  })
  it('keeps a pushable prior tier for a normal name', () => {
    expect(resolvedTier('x.md', 'user')).toBe('user')
    expect(resolvedTier('x.md', 'team-knowledge')).toBe('team-knowledge')
  })
  it('falls back to hivemind for a tier-less or non-pushable prior', () => {
    expect(resolvedTier('x.md', '')).toBe('hivemind')
    expect(resolvedTier('x.md', 'hivemind')).toBe('hivemind')
  })
})

describe('localDivergence tierChange', () => {
  it('is null when install would keep the tier', async () => {
    const svc = await installedReference({ pinned: '# note\n', head: '# note v2\n' })
    expect((await svc.localDivergence('hive-note.md')).tierChange).toBeNull()
  })

  it('reports the restamp even when the content is identical', async () => {
    // A confluence/ twin over a user-tier local copy: byte-identical content, but install
    // force-stamps `confluence` and the user silently loses push rights.
    const clone = seedClone()
    fs.mkdirSync(path.join(clone, 'references', 'confluence'), { recursive: true })
    fs.writeFileSync(path.join(clone, 'references', 'confluence', 'hive-note.md'), '# note\n')
    fs.mkdirSync(path.join(home, 'references'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'references', 'hive-note.md'),
      '---\ntrust_tier: user\n---\n# note\n'
    )
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: async (_c, args) => (args[0] === 'show' ? '# note\n' : args[0] === 'log' ? 'pinsha' : '')
    })
    await svc.install('reference', 'confluence/hive-note.md', { overwriteLocalEdits: true })
    fs.writeFileSync(
      path.join(home, 'references', 'hive-note.md'),
      '---\ntrust_tier: user\n---\n# note\n'
    )
    const d = await svc.localDivergence('confluence/hive-note.md')
    expect(d.diverged).toBe(false)
    expect(d.tierChange).toEqual({ from: 'user', to: 'confluence' })
  })
})

describe('sameContents', () => {
  it('compares by key and value, and treats a size difference as different', () => {
    expect(sameContents(new Map([['a', '1']]), new Map([['a', '1']]))).toBe(true)
    expect(sameContents(new Map([['a', '1']]), new Map([['a', '2']]))).toBe(false)
    expect(sameContents(new Map([['a', '1']]), new Map([['b', '1']]))).toBe(false)
    expect(
      sameContents(
        new Map([['a', '1']]),
        new Map([
          ['a', '1'],
          ['b', '2']
        ])
      )
    ).toBe(false)
  })
})

describe('pushStatus', () => {
  const me = { name: 'Jiawei Han', email: 'me@example.test' }
  const MINE = 'jiawei-han'

  /** A user-tier skill + reference, both authored solely by `me` unless `extraContributor`. */
  function seedAssets(extraContributor = false): void {
    const trail = [
      '---',
      'name: my-skill',
      'description: mine',
      'author: Jiawei Han <me@example.test>',
      'contributors:',
      '  - Jiawei Han <me@example.test> 2026-08-01',
      ...(extraContributor ? ['  - Alex Chen <alex@example.test> 2026-08-02'] : []),
      '---',
      '# my-skill\n'
    ].join('\n')
    fs.mkdirSync(path.join(home, 'skills-user', 'my-skill'), { recursive: true })
    fs.writeFileSync(path.join(home, 'skills-user', 'my-skill', 'SKILL.md'), trail)
  }

  /** The state file lives at `<home>/config/hivemind-state.json` (see `hivemindStatePath`), and
   *  nothing has called `store.write()` yet at this point, so write it directly. */
  function writeState(pushes: Record<string, { prUrl: string; pushedAt: string }>): void {
    const statePath = path.join(home, 'config', 'hivemind-state.json')
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(
      statePath,
      JSON.stringify({ lastSynced: null, skills: {}, references: {}, pushes })
    )
  }

  it('is none for a sole-authored asset that was never pushed, and calls no gh', async () => {
    seedClone()
    seedAssets()
    const ghCalls: string[][] = []
    const gh: Runner = async (_c, args) => {
      ghCalls.push(args)
      return ''
    }
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: fakeGit().runner,
      gh
    })
    expect(await svc.pushStatus('skill', 'my-skill', me)).toEqual({ state: 'none' })
    expect(ghCalls).toEqual([])
  })

  it('is none when the receipt PR has been merged or closed', async () => {
    seedClone()
    seedAssets()
    writeState({ 'skill/my-skill': { prUrl: 'https://pr/7', pushedAt: '2026-08-01T00:00:00Z' } })
    const gh: Runner = async () => JSON.stringify({ state: 'MERGED', headRefName: 'argus/share-skill-my-skill-1' })
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: fakeGit().runner,
      gh
    })
    expect(await svc.pushStatus('skill', 'my-skill', me)).toEqual({ state: 'none' })
  })

  it('is open-mine + unchanged when the branch tip matches the local skill tree', async () => {
    seedClone()
    seedAssets()
    writeState({ 'skill/my-skill': { prUrl: 'https://pr/7', pushedAt: '2026-08-01T00:00:00Z' } })
    const local = fs.readFileSync(path.join(home, 'skills-user', 'my-skill', 'SKILL.md'), 'utf8')
    const git: Runner = async (_c, args) => {
      if (args[0] === 'ls-tree') return 'skills/my-skill/SKILL.md'
      // `git show` through the real runner is trimmed; mimic that here so the test proves
      // pushStatus normalizes rather than accidentally comparing equal-with-newline strings.
      if (args[0] === 'show') return local.trim()
      return ''
    }
    const gh: Runner = async () =>
      JSON.stringify({ state: 'OPEN', headRefName: 'argus/share-skill-my-skill-1' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git, gh })
    expect(await svc.pushStatus('skill', 'my-skill', me)).toEqual({
      state: 'open-mine',
      prUrl: 'https://pr/7',
      changed: false
    })
  })

  it('is open-mine + changed when a file was added to the skill dir since the push', async () => {
    seedClone()
    seedAssets()
    writeState({ 'skill/my-skill': { prUrl: 'https://pr/7', pushedAt: '2026-08-01T00:00:00Z' } })
    const local = fs.readFileSync(path.join(home, 'skills-user', 'my-skill', 'SKILL.md'), 'utf8')
    fs.writeFileSync(path.join(home, 'skills-user', 'my-skill', 'NOTES.md'), '# new file\n')
    const git: Runner = async (_c, args) => {
      if (args[0] === 'ls-tree') return 'skills/my-skill/SKILL.md'
      if (args[0] === 'show') return local.trim()
      return ''
    }
    const gh: Runner = async () =>
      JSON.stringify({ state: 'OPEN', headRefName: 'argus/share-skill-my-skill-1' })
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git, gh })
    expect(await svc.pushStatus('skill', 'my-skill', me)).toEqual({
      state: 'open-mine',
      prUrl: 'https://pr/7',
      changed: true
    })
  })

  it('searches GitHub when a teammate contributed, and blocks on their open PR', async () => {
    seedClone()
    seedAssets(true)
    const ghCalls: string[][] = []
    const gh: Runner = async (_c, args) => {
      ghCalls.push(args)
      if (args[0] === 'api') return 'jiawei-han'
      return JSON.stringify([
        { url: 'https://pr/42', headRefName: 'argus/share-skill-my-skill-999', author: { login: 'alex' } }
      ])
    }
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: fakeGit().runner,
      gh
    })
    expect(await svc.pushStatus('skill', 'my-skill', me)).toEqual({
      state: 'open-teammate',
      prUrl: 'https://pr/42',
      prAuthor: 'alex'
    })
    expect(ghCalls.some((c) => c[0] === 'pr' && c[1] === 'list')).toBe(true)
  })

  it('a shared-authorship asset whose open PR is mine resolves to open-mine, not blocked', async () => {
    seedClone()
    seedAssets(true)
    const local = fs.readFileSync(path.join(home, 'skills-user', 'my-skill', 'SKILL.md'), 'utf8')
    const gh: Runner = async (_c, args) => {
      if (args[0] === 'api') return MINE
      return JSON.stringify([
        { url: 'https://pr/42', headRefName: 'argus/share-skill-my-skill-999', author: { login: MINE } }
      ])
    }
    const git: Runner = async (_c, args) => {
      if (args[0] === 'ls-tree') return 'skills/my-skill/SKILL.md'
      if (args[0] === 'show') return local.trim()
      return ''
    }
    const svc = new HivemindService({ argusHome: home, repo: () => 'acme/hivemind', git, gh })
    expect(await svc.pushStatus('skill', 'my-skill', me)).toEqual({
      state: 'open-mine',
      prUrl: 'https://pr/42',
      changed: false
    })
  })

  it('ignores open PRs whose branch is for a different asset', async () => {
    seedClone()
    seedAssets(true)
    const gh: Runner = async (_c, args) => {
      if (args[0] === 'api') return MINE
      return JSON.stringify([
        { url: 'https://pr/1', headRefName: 'argus/share-skill-other-skill-1', author: { login: 'alex' } },
        { url: 'https://pr/2', headRefName: 'some/unrelated-branch', author: { login: 'alex' } }
      ])
    }
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: fakeGit().runner,
      gh
    })
    expect(await svc.pushStatus('skill', 'my-skill', me)).toEqual({ state: 'none' })
  })

  it('fails open with a warning when gh throws, so sharing is never blocked by a broken check', async () => {
    seedClone()
    seedAssets()
    writeState({ 'skill/my-skill': { prUrl: 'https://pr/7', pushedAt: '2026-08-01T00:00:00Z' } })
    const gh: Runner = async () => {
      throw new Error('gh: not authenticated')
    }
    const svc = new HivemindService({
      argusHome: home,
      repo: () => 'acme/hivemind',
      git: fakeGit().runner,
      gh
    })
    const s = await svc.pushStatus('skill', 'my-skill', me)
    expect(s.state).toBe('none')
    expect(s.state === 'none' && s.warning).toMatch(/not authenticated/)
  })
})
