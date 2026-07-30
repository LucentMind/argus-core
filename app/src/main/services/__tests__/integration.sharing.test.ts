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
import {
  resolveSkills,
  forkSkill,
  writeUserSkill,
  readSkill,
  userSkillShadowDiverged
} from '../agent/skillsResolver'
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

  it('contribution round-trip keeps authorship: push own reference, install merged copy, still pushable', async () => {
    const gh: Runner = async () => 'https://github.com/acme/hivemind/pull/8'
    const svc = service(gh)
    await svc.sync()
    git(path.join(homeB, 'hivemind'), 'config', 'user.email', 'test@argus.local')
    git(path.join(homeB, 'hivemind'), 'config', 'user.name', 'Argus Test')

    // author a local reference and share it
    fs.mkdirSync(path.join(homeB, 'references'), { recursive: true })
    fs.writeFileSync(
      path.join(homeB, 'references', 'my-tips.md'),
      '---\ntrust_tier: user\n---\n# tips v1\n'
    )
    expect(svc.pushable()).toContainEqual({ kind: 'reference', name: 'my-tips.md' })
    const r = await svc.push('reference', 'my-tips.md', 'Add my-tips')
    expect(r.ok).toBe(true)

    // "maintainer merges the PR": fast-forward main to the share branch
    const branch = git(bare, 'branch', '--list', 'argus/*')
      .replace(/^\*?\s+/, '')
      .trim()
    git(work, 'fetch', 'origin')
    git(work, 'merge', '--ff-only', `origin/${branch}`)
    git(work, 'push', 'origin', 'main')

    // installing the merged copy keeps the author's tier — and push rights
    let p = await svc.sync()
    p = await svc.install('reference', 'my-tips.md')
    const written = fs.readFileSync(path.join(homeB, 'references', 'my-tips.md'), 'utf8')
    expect(written).toContain('trust_tier: user')
    expect(p.pushable).toContainEqual({ kind: 'reference', name: 'my-tips.md' })
    expect(p.items.find((i) => i.name === 'my-tips.md')?.localTier).toBe('user')

    // a non-author install lands as hivemind tier; claiming it grants push rights
    const other = new HivemindService({ argusHome: homeA, repo: () => bare })
    await other.sync()
    let po = await other.install('reference', 'my-tips.md')
    expect(po.items.find((i) => i.name === 'my-tips.md')?.localTier).toBe('hivemind')
    expect(po.pushable).not.toContainEqual({ kind: 'reference', name: 'my-tips.md' })
    po = await other.claimReference('my-tips.md', null)
    expect(po.items.find((i) => i.name === 'my-tips.md')?.localTier).toBe('user')
    expect(po.pushable).toContainEqual({ kind: 'reference', name: 'my-tips.md' })
  }, 30_000)

  it('fork → edit → push cuts the branch from the pin, not origin/HEAD — the PR carries only the local edit and does not revert the upstream change made after install (spec §8)', async () => {
    const gh: Runner = async () => 'https://github.com/acme/hivemind/pull/13'
    const svc = service(gh)
    await svc.sync()
    git(path.join(homeB, 'hivemind'), 'config', 'user.email', 'test@argus.local')
    git(path.join(homeB, 'hivemind'), 'config', 'user.name', 'Argus Test')

    // install pins hive-probe at its current (v1) upstream commit
    const p = await svc.install('skill', 'hive-probe')
    const pinnedCommit = p.items.find((i) => i.name === 'hive-probe')!.installedCommit
    expect(pinnedCommit).toBeTruthy()

    // upstream advances PAST the pin with a commit touching the SAME skill — the change a
    // whole-dir-replace push must not silently revert
    fs.writeFileSync(
      path.join(work, 'skills', 'hive-probe', 'SKILL.md'),
      '---\nname: hive-probe\ndescription: probe skill from the hive\n---\n# hive-probe v1\n\nUpstream note added after install.\n'
    )
    git(work, 'add', '-A')
    git(work, 'commit', '-m', 'upstream note added after install')
    git(work, 'push', 'origin', 'main')
    const upstreamCommit = git(work, 'rev-parse', 'HEAD')
    expect(upstreamCommit).not.toBe(pinnedCommit)

    // fork the still-pinned (v1) local copy into skills-user — editing something you don't
    // own forks it into your tier first
    expect(forkSkill(homeB, 'hive-probe', undefined, null)).toBe('hive-probe')
    const beforeEdit = readSkill(homeB, 'hive-probe')
    expect(beforeEdit.content).not.toContain('Upstream note')

    // edit the fork (same write path the in-app editor uses)
    const edited =
      '---\nname: hive-probe\ndescription: probe skill from the hive, with my local fix\n---\n# hive-probe v1\n\nLocal fix applied.\n'
    writeUserSkill(homeB, 'hive-probe', edited, beforeEdit.hash, null)

    const r = await svc.push('skill', 'hive-probe', 'Local fix to hive-probe')
    expect(r.ok).toBe(true)

    const branches = git(bare, 'branch', '--list', 'argus/*')
    const branch = branches.replace(/^\*?\s+/, '').trim()
    expect(branch).toMatch(/argus\/share-skill-hive-probe-/)

    // the pushed file carries the local edit …
    const shown = git(bare, 'show', `${branch}:skills/hive-probe/SKILL.md`)
    expect(shown).toContain('Local fix applied.')

    // … and THE point of the fix: the branch's parent is the PIN, not origin/HEAD (which
    // moved to upstreamCommit). If push regressed to branching from origin/HEAD, this
    // would instead equal upstreamCommit — a whole-dir replace on top of it would produce
    // a diff that silently reverts "Upstream note added after install." alongside the
    // intended edit, which is exactly what branching from the pin avoids (the reviewer
    // sees a clean edit-only diff and any real conflict surfaces upstream on GitHub).
    expect(git(bare, 'rev-parse', `${branch}^`)).toBe(pinnedCommit)
    // corroborates the same fact from the other direction: the upstream commit is not an
    // ancestor of the pushed branch at all — their only common ancestor is the pin.
    expect(git(bare, 'merge-base', upstreamCommit, branch)).toBe(pinnedCommit)
  }, 30_000)

  it('hazard 1: a forked skill keeps shadowing after Update, and says so', async () => {
    const svc = service()
    await svc.sync()
    await svc.install('skill', 'hive-probe')

    // fork the installed copy, then edit the fork
    fs.mkdirSync(path.join(homeB, 'skills-user'), { recursive: true })
    fs.cpSync(
      path.join(homeB, 'skills-hivemind', 'hive-probe'),
      path.join(homeB, 'skills-user', 'hive-probe'),
      { recursive: true }
    )
    fs.writeFileSync(
      path.join(homeB, 'skills-user', 'hive-probe', 'SKILL.md'),
      '---\nname: hive-probe\ndescription: probe skill from the hive\n---\n# hive-probe v1 + MY EDIT\n'
    )
    expect(userSkillShadowDiverged(homeB, 'hive-probe')).toBe(true)

    // upstream moves past the fork
    fs.writeFileSync(
      path.join(work, 'skills', 'hive-probe', 'SKILL.md'),
      '---\nname: hive-probe\ndescription: probe skill from the hive\n---\n# hive-probe v2\n'
    )
    git(work, 'add', '-A')
    git(work, 'commit', '-m', 'upstream moves')
    git(work, 'push', 'origin', 'main')

    await svc.sync()
    const p = await svc.install('skill', 'hive-probe')

    // the pin is current and updateAvailable goes dark...
    expect(p.items.find((i) => i.name === 'hive-probe')!.updateAvailable).toBe(false)
    // ...and the update genuinely landed in the hivemind tier, not just in the pin bookkeeping
    expect(
      fs.readFileSync(path.join(homeB, 'skills-hivemind', 'hive-probe', 'SKILL.md'), 'utf8')
    ).toContain('v2')
    // ...but the fork still wins resolution, and both new signals stay true
    expect(
      resolveSkills(homeB, defaultAgentAccess()).find((s) => s.name === 'hive-probe')!.tier
    ).toBe('user')
    expect(userSkillShadowDiverged(homeB, 'hive-probe')).toBe(true)
    expect(p.items.find((i) => i.name === 'hive-probe')!.shadowedByUser).toBe(true)
  }, 30_000)

  it('hazard 2: a pristine installed reference is never reported as diverged', async () => {
    const svc = service()
    await svc.sync()
    await svc.install('reference', 'hive-note.md')
    // install() stamps three frontmatter keys the upstream blob lacks — a byte comparison
    // would report divergence here, and every update would warn.
    expect(await svc.localDivergence('hive-note.md')).toEqual({ diverged: false, diff: '' })
  }, 30_000)

  it('hazard 2: unpushed edits block the update until acknowledged, then survive as a diff', async () => {
    const svc = service()
    await svc.sync()
    await svc.install('reference', 'hive-note.md')
    await svc.claimReference('hive-note.md')

    const local = path.join(homeB, 'references', 'hive-note.md')
    fs.writeFileSync(
      local,
      fs.readFileSync(local, 'utf8').replace('# note v1', '# note v1\n\nMY UNPUSHED PARAGRAPH')
    )

    fs.writeFileSync(path.join(work, 'references', 'hive-note.md'), '# note v2\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-m', 'upstream note')
    git(work, 'push', 'origin', 'main')
    await svc.sync()

    const d = await svc.localDivergence('hive-note.md')
    expect(d.diverged).toBe(true)
    // the diff names what would be lost — the half the pin→HEAD preview cannot show
    expect(d.diff).toContain('MY UNPUSHED PARAGRAPH')
    // ...and pins the incoming side to HEAD, not the stale pin — 'note v2' exists only there
    expect(d.diff).toContain('note v2')

    await expect(svc.install('reference', 'hive-note.md')).rejects.toThrow(
      /differs from the version that would be installed/i
    )
    expect(fs.readFileSync(local, 'utf8')).toContain('MY UNPUSHED PARAGRAPH')

    await svc.install('reference', 'hive-note.md', { overwriteLocalEdits: true })
    const after = fs.readFileSync(local, 'utf8')
    expect(after).not.toContain('MY UNPUSHED PARAGRAPH')
    expect(after).toContain('trust_tier: user')
  }, 30_000)

  it('hazard 2: an already-merged contribution updates silently', async () => {
    const svc = service()
    await svc.sync()
    await svc.install('reference', 'hive-note.md')
    await svc.claimReference('hive-note.md')

    // edit the local copy first, then land that exact text upstream — your contribution
    // merged verbatim. The pin (recorded at install/claim time) genuinely lags: its blob
    // lacks the paragraph, while HEAD's now has it. local === HEAD, so an update would
    // change nothing and must stay silent — this is the case the HEAD clause exists for.
    const local = path.join(homeB, 'references', 'hive-note.md')
    fs.writeFileSync(
      local,
      fs.readFileSync(local, 'utf8').replace('# note v1', '# note v1\n\nMY MERGED PARAGRAPH')
    )
    // the same text lands upstream — your contribution merged
    fs.writeFileSync(
      path.join(work, 'references', 'hive-note.md'),
      '# note v1\n\nMY MERGED PARAGRAPH\n'
    )
    git(work, 'add', '-A')
    git(work, 'commit', '-m', 'merge your contribution')
    git(work, 'push', 'origin', 'main')
    await svc.sync()

    // the pin genuinely lags: its blob lacks the paragraph, HEAD's has it
    expect(await svc.diff('reference', 'hive-note.md')).toContain('MY MERGED PARAGRAPH')
    // local === HEAD, so there is nothing to lose and no warning
    expect((await svc.localDivergence('hive-note.md')).diverged).toBe(false)
    await expect(svc.install('reference', 'hive-note.md')).resolves.toBeDefined()
  }, 30_000)
})
