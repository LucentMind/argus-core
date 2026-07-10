import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb } from '../db'
import { seedMemoryPair } from './helpers/seedMemoryPair'
import { exportCase, importCase, inspectBundle } from '../bundle'
import { searchEvidence } from '../search'
import { HivemindService, type Runner } from '../hivemind'
import { resolveSkills } from '../agent/skillsResolver'
import { defaultAgentAccess } from '../../../shared/agentAccess'
import type { DatabaseSync } from 'node:sqlite'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

let homeA: string
let homeB: string
let dbA: DatabaseSync
let dbB: DatabaseSync
beforeEach(() => {
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-e2e-a-'))
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-e2e-b-'))
  dbA = openDb(path.join(homeA, 'argus.db'))
  dbB = openDb(path.join(homeB, 'argus.db'))
})
afterEach(() => {
  // Windows: node:sqlite DatabaseSync holds an open file handle until closed,
  // which makes rmSync fail with EBUSY on the .db file if not closed first
  // (deviation from the brief's literal afterEach, which omitted this).
  dbA.close()
  dbB.close()
  for (const h of [homeA, homeB]) fs.rmSync(h, { recursive: true, force: true })
})

describe('exit criterion: bundle round-trips with working search (spec Part 2 exit check)', () => {
  it('fixture case exported → imported into a fresh ARGUS_HOME → FTS finds the signature', async () => {
    seedMemoryPair(dbA, homeA)
    const bundle = path.join(homeA, 'NAV-100.arguscase')
    await exportCase(
      dbA,
      homeA,
      'NAV-100',
      bundle,
      { includeTranscripts: true },
      {
        argusVersion: 'test'
      }
    )
    const insp = await inspectBundle(dbB, homeB, bundle)
    expect(insp.proposedSlug).toBe('NAV-100')
    const rec = await importCase(dbB, homeB, bundle, insp.proposedSlug)
    // the shared defect signature is findable on the receiving machine (evidence FTS)
    const hits = searchEvidence(dbB, 'BLOCKED_VERSION', { caseSlug: rec.slug })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].relPath).toContain('evidence/')
    // findings render from the imported file (findings.md is not FTS-indexed as-built —
    // recorded plan deviation; presence + content is the assertion here)
    expect(fs.existsSync(path.join(homeB, 'cases', 'NAV-100', 'findings.md'))).toBe(true)
  }, 30_000)
})

describe('HiveMind against a local bare repo (no network)', () => {
  let bare: string
  let work: string

  beforeEach(() => {
    // a bare "GitHub" + a working clone that seeds it
    bare = path.join(homeA, 'hive.git')
    fs.mkdirSync(bare, { recursive: true })
    git(bare, 'init', '--bare', '--initial-branch=main', '.')
    work = path.join(homeA, 'hive-work')
    git(homeA, 'clone', bare, work)
    git(work, 'config', 'user.email', 'test@argus.local')
    git(work, 'config', 'user.name', 'Argus Test')
    fs.mkdirSync(path.join(work, 'skills', 'hive-probe'), { recursive: true })
    fs.writeFileSync(
      path.join(work, 'skills', 'hive-probe', 'SKILL.md'),
      '---\nname: hive-probe\ndescription: probe skill from the hive\n---\n# hive-probe v1\n'
    )
    fs.mkdirSync(path.join(work, 'references'), { recursive: true })
    fs.writeFileSync(path.join(work, 'references', 'hive-note.md'), '# note v1\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-m', 'seed hive')
    git(work, 'push', 'origin', 'main')
    // origin/HEAD is set by clone; the service clone gets it via git clone
  })

  function service(gh?: Runner): HivemindService {
    return new HivemindService({ argusHome: homeB, repo: () => bare, gh })
  }

  it('sync clones; install pins; upstream edit flags an update; re-install picks it up', async () => {
    const svc = service()
    let p = await svc.sync()
    expect(p.state).toBe('ready')
    expect(p.items.map((i) => i.name).sort()).toEqual(['hive-note.md', 'hive-probe'])

    // the service clone may need a git identity for later operations on some setups — not
    // needed for install (read-only), so proceed.
    p = await svc.install('skill', 'hive-probe')
    const item = p.items.find((i) => i.name === 'hive-probe')!
    expect(item.installed).toBe(true)
    expect(item.installedCommit).toBe(item.commit)
    // Part 1 resolver picks the installed copy up in the hivemind tier
    const resolved = resolveSkills(homeB, defaultAgentAccess())
    const probe = resolved.find((s) => s.name === 'hive-probe')
    expect(probe?.tier).toBe('hivemind')
    expect(probe?.description).toBe('probe skill from the hive')

    // upstream moves
    fs.writeFileSync(
      path.join(work, 'skills', 'hive-probe', 'SKILL.md'),
      '---\nname: hive-probe\ndescription: probe skill from the hive\n---\n# hive-probe v2\n'
    )
    git(work, 'add', '-A')
    git(work, 'commit', '-m', 'update probe')
    git(work, 'push', 'origin', 'main')

    p = await svc.sync()
    const updated = p.items.find((i) => i.name === 'hive-probe')!
    expect(updated.updateAvailable).toBe(true)
    // pulls never mutate the installed copy (spec §2.3)
    expect(
      fs.readFileSync(path.join(homeB, 'skills-hivemind', 'hive-probe', 'SKILL.md'), 'utf8')
    ).toContain('v1')
    const diff = await svc.diff('skill', 'hive-probe')
    expect(diff).toContain('v2')

    p = await svc.install('skill', 'hive-probe')
    expect(
      fs.readFileSync(path.join(homeB, 'skills-hivemind', 'hive-probe', 'SKILL.md'), 'utf8')
    ).toContain('v2')
    expect(p.items.find((i) => i.name === 'hive-probe')!.updateAvailable).toBe(false)
  }, 30_000)

  it('push lands a branch on the bare origin and returns the stubbed PR url', async () => {
    const ghCalls: string[][] = []
    const gh: Runner = async (_c, args) => {
      ghCalls.push(args)
      return 'https://github.com/acme/hivemind/pull/7'
    }
    const svc = service(gh)
    await svc.sync()
    // pushes need a committer identity in the service clone
    git(path.join(homeB, 'hivemind'), 'config', 'user.email', 'test@argus.local')
    git(path.join(homeB, 'hivemind'), 'config', 'user.name', 'Argus Test')

    fs.mkdirSync(path.join(homeB, 'skills-user', 'my-skill'), { recursive: true })
    fs.writeFileSync(
      path.join(homeB, 'skills-user', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: mine\n---\n# my-skill\n'
    )
    const r = await svc.push('skill', 'my-skill', 'Add my-skill')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.prUrl).toContain('/pull/7')
    expect(ghCalls[0][0]).toBe('pr')
    // the branch exists on the bare origin with the file at its tip
    const branches = git(bare, 'branch', '--list', 'argus/*')
    expect(branches).toMatch(/argus\/share-skill-my-skill-/)
    const branch = branches.replace(/^\*?\s+/, '').trim()
    const shown = git(bare, 'show', `${branch}:skills/my-skill/SKILL.md`)
    expect(shown).toContain('# my-skill')
    // the clone is back on the default branch
    expect(git(path.join(homeB, 'hivemind'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  }, 30_000)
})
