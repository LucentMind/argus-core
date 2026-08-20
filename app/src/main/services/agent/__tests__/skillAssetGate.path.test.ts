import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { skillAssetAt } from '../skillAssetGate'
import { hivemindSkillsDir, userSkillsDir } from '../../paths'
import { sharedSkillsDir } from '../../skillsDir'

const isWin = process.platform === 'win32'

/** `C:\Users\x\y.sh` -> `/c/Users/x/y.sh`, the absolute-path spelling git-bash uses. */
function msys(win: string): string {
  return `/${win[0].toLowerCase()}${win.slice(2).replace(/\\/g, '/')}`
}

let home: string
let caseDir: string

/** Write a skill directory in `root` and return the absolute path of one asset inside it. */
function seed(root: string, skill: string, rel: string, body: string): string {
  const abs = path.join(root, skill, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  return abs
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-asset-gate-'))
  caseDir = path.join(home, 'cases', 'ACME-1')
  fs.mkdirSync(path.join(caseDir, '.claude', 'skills'), { recursive: true })
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('skillAssetAt', () => {
  it('identifies a user-tier asset by its real path', () => {
    const abs = seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    expect(skillAssetAt(home, abs)).toEqual({
      tier: 'user',
      skill: 'collect-logs',
      relPath: 'scripts/collect.sh'
    })
  })

  it('identifies the hivemind and bundled tiers too', () => {
    const hive = seed(hivemindSkillsDir(home), 'team-skill', 'run.sh', 'echo hi\n')
    const bundled = seed(sharedSkillsDir(home), 'packed', 'bin/go', 'echo hi\n')
    expect(skillAssetAt(home, hive)).toMatchObject({ tier: 'hivemind', skill: 'team-skill' })
    expect(skillAssetAt(home, bundled)).toMatchObject({ tier: 'bundled', skill: 'packed' })
  })

  // The one that matters: this is the ONLY path a shell command actually sees, because
  // materializeSessionSkills junctions each enabled skill into the case directory.
  it('resolves through the per-case junction to the real tier', () => {
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    fs.symlinkSync(
      path.join(userSkillsDir(home), 'collect-logs'),
      path.join(caseDir, '.claude', 'skills', 'collect-logs'),
      'junction'
    )
    const viaJunction = path.join(
      caseDir,
      '.claude',
      'skills',
      'collect-logs',
      'scripts',
      'collect.sh'
    )
    expect(skillAssetAt(home, viaJunction)).toEqual({
      tier: 'user',
      skill: 'collect-logs',
      relPath: 'scripts/collect.sh'
    })
  })

  it('reports a nested asset with a POSIX relative path on every platform', () => {
    const abs = seed(userSkillsDir(home), 'deep', 'a/b/c.sh', 'echo hi\n')
    expect(skillAssetAt(home, abs)?.relPath).toBe('a/b/c.sh')
  })

  it('returns null for a path outside every skills root', () => {
    const abs = path.join(caseDir, 'evidence', 'notes.sh')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'echo hi\n')
    expect(skillAssetAt(home, abs)).toBeNull()
  })

  it('returns null for a path that does not exist', () => {
    expect(skillAssetAt(home, path.join(userSkillsDir(home), 'ghost', 'x.sh'))).toBeNull()
  })

  // `skills-user-backup` shares a prefix with `skills-user`; a raw startsWith would claim it.
  it('does not claim a sibling directory that merely shares a prefix', () => {
    const abs = path.join(home, 'skills-user-backup', 'collect-logs', 'x.sh')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'echo hi\n')
    expect(skillAssetAt(home, abs)).toBeNull()
  })

  it('returns null for the skill directory itself, which is not an asset', () => {
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    expect(skillAssetAt(home, path.join(userSkillsDir(home), 'collect-logs'))).toBeNull()
  })
})

// Windows only, because the rewrite itself is: on Linux and macOS `/c/Users/…` is an ordinary
// absolute path and must never be reinterpreted. Every test above builds its paths with
// `path.join`, which is why none of them saw this: `path.join` produces the `C:\…` spelling, and
// the shell Argus spawns on Windows is git-bash, whose native spelling is `/c/…`.
describe.skipIf(!isWin)('skillAssetAt — MSYS (git-bash) path spellings', () => {
  it('identifies an asset named with an MSYS absolute path', () => {
    const abs = seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    expect(skillAssetAt(home, msys(abs))).toEqual(skillAssetAt(home, abs))
    expect(skillAssetAt(home, msys(abs))).toEqual({
      tier: 'user',
      skill: 'collect-logs',
      relPath: 'scripts/collect.sh'
    })
  })

  // What `skillAssetContextForSegment` actually hands over: `path.resolve(caseDir, '/c/…')`
  // reads the leading `/` as "root of the current drive" and leaves the drive letter behind as a
  // literal directory, so the gate sees `C:\c\Users\…`.
  it('identifies it through the path.resolve-mangled spelling too', () => {
    const abs = seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    const mangled = path.resolve(caseDir, msys(abs))
    expect(mangled.toLowerCase()).toContain(`${path.sep}c${path.sep}`)
    expect(skillAssetAt(home, mangled)).toEqual({
      tier: 'user',
      skill: 'collect-logs',
      relPath: 'scripts/collect.sh'
    })
  })

  it('rewrites only a single drive letter, never a multi-letter first segment', () => {
    const abs = seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    // `/usr/<same tail>` — an implementation that stripped the first segment regardless of its
    // length, or that ignored the letter and reused the current drive, would find the asset here.
    expect(skillAssetAt(home, `/usr${abs.slice(2).replace(/\\/g, '/')}`)).toBeNull()
    expect(skillAssetAt(home, `/config${abs.slice(2).replace(/\\/g, '/')}`)).toBeNull()
    expect(skillAssetAt(home, '/usr/bin/env')).toBeNull()
  })

  // Precedence. `C:\c\Users\…` can legitimately exist (a directory literally named `c` at the
  // drive root), so the literal resolution must be tried first and a real path must never be
  // shadowed by the speculative rewrite. Stubbed rather than seeded: the literal resolution of
  // an MSYS path always lands at a DRIVE ROOT, which a test has no business writing to.
  function withLiteralAt(literal: string, target: string | null, fn: () => void): void {
    const orig = fs.realpathSync.native
    const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike) => {
      if (p === literal) {
        if (target === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return orig(target)
      }
      return orig(p)
    }) as typeof fs.realpathSync.native)
    try {
      fn()
    } finally {
      spy.mockRestore()
    }
  }

  it('prefers a real path at the literal resolution over the rewrite', () => {
    const literalAsset = seed(userSkillsDir(home), 'literal-skill', 'run.sh', 'echo lit\n')
    const rewriteAsset = seed(userSkillsDir(home), 'rewrite-skill', 'run.sh', 'echo rew\n')
    const token = msys(rewriteAsset)
    withLiteralAt(token, literalAsset, () => {
      expect(skillAssetAt(home, token)).toMatchObject({ skill: 'literal-skill' })
    })
    // …and with nothing at the literal resolution, the rewrite is what answers.
    withLiteralAt(token, null, () => {
      expect(skillAssetAt(home, token)).toMatchObject({ skill: 'rewrite-skill' })
    })
  })

  // The decoy. A NON-asset at the literal resolution must not blind the rewrite: `mkdir -p
  // "C:/c/Users/…"` classifies as allow/LOW (nothing polices `mkdir`), so an agent that could
  // stop the fallback by creating a directory could switch the gate off for its own script.
  // The cost of falling through is a card that could name a script the command is not running —
  // a false ask, the safe direction in a design whose failure mode is a MISSING ask.
  it('falls back to the rewrite when the literal resolution exists but is no asset', () => {
    const outside = path.join(caseDir, 'evidence', 'notes.sh')
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    fs.writeFileSync(outside, 'echo hi\n')
    const rewriteAsset = seed(userSkillsDir(home), 'rewrite-skill', 'run.sh', 'echo rew\n')
    const token = msys(rewriteAsset)
    withLiteralAt(token, outside, () => {
      expect(skillAssetAt(home, token)).toMatchObject({ skill: 'rewrite-skill' })
    })
  })
})

/**
 * `~/Argus/skills-user/<skill>/scripts/run.sh` is, on a default install, the SHORTEST correct
 * absolute path to a skill script (`resolveArgusHome` defaults to `~/Argus`). Every shell Argus
 * spawns expands it and `path.resolve` does not, so before this it produced the same total bypass
 * the git-bash spelling did: no asset, no card, script runs.
 *
 * NOT platform-gated, unlike the MSYS block above: `~` is a POSIX shell feature and the gap is
 * identical on macOS and Linux.
 */
describe('skillAssetAt — tilde (~) home spellings', () => {
  /** The user's home directory, injected — `home` above plays ARGUS_HOME, which on a default
   *  install sits at `~/Argus`. Laid out that way here so the tokens are the real ones. */
  let userHome: string
  let argusHome: string
  let tildeCaseDir: string

  beforeEach(() => {
    userHome = home
    argusHome = path.join(home, 'Argus')
    tildeCaseDir = path.join(argusHome, 'cases', 'ACME-1')
    fs.mkdirSync(tildeCaseDir, { recursive: true })
  })

  it('identifies an asset named with a ~-rooted path', () => {
    const abs = seed(userSkillsDir(argusHome), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    const token = '~/Argus/skills-user/collect-logs/scripts/collect.sh'
    expect(skillAssetAt(argusHome, token, userHome)).toEqual(skillAssetAt(argusHome, abs, userHome))
    expect(skillAssetAt(argusHome, token, userHome)).toEqual({
      tier: 'user',
      skill: 'collect-logs',
      relPath: 'scripts/collect.sh'
    })
  })

  // What `skillAssetContextForSegment` actually hands over: `path.resolve(caseDir, '~/…')` glues
  // the tilde on as a literal directory name under the case directory.
  it('identifies it through the path.resolve-mangled spelling too', () => {
    seed(userSkillsDir(argusHome), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    const mangled = path.resolve(
      tildeCaseDir,
      '~/Argus/skills-user/collect-logs/scripts/collect.sh'
    )
    expect(mangled).toContain(`${path.sep}~${path.sep}`)
    expect(skillAssetAt(argusHome, mangled, userHome)).toEqual({
      tier: 'user',
      skill: 'collect-logs',
      relPath: 'scripts/collect.sh'
    })
  })

  it('accepts the backslash spelling of the same token', () => {
    seed(userSkillsDir(argusHome), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    const token = '~\\Argus\\skills-user\\collect-logs\\scripts\\collect.sh'
    expect(skillAssetAt(argusHome, token, userHome)).toMatchObject({ skill: 'collect-logs' })
  })

  it('does not expand ~user or a bare ~', () => {
    seed(userSkillsDir(argusHome), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    expect(
      skillAssetAt(
        argusHome,
        '~notauser/Argus/skills-user/collect-logs/scripts/collect.sh',
        userHome
      )
    ).toBeNull()
    expect(skillAssetAt(argusHome, '~', userHome)).toBeNull()
    expect(skillAssetAt(argusHome, '~/', userHome)).toBeNull()
  })

  // Finding 2 again, for the tilde: a real directory literally named `~` under the case dir must
  // not switch the expansion off. Seeded for real — unlike the MSYS literal, this one does not
  // land at a drive root.
  it('falls back to the expansion when the literal ~ directory exists but holds no asset', () => {
    const decoy = path.join(
      tildeCaseDir,
      '~',
      'Argus',
      'skills-user',
      'collect-logs',
      'scripts',
      'collect.sh'
    )
    fs.mkdirSync(path.dirname(decoy), { recursive: true })
    fs.writeFileSync(decoy, 'echo decoy\n')
    seed(userSkillsDir(argusHome), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    const mangled = path.resolve(
      tildeCaseDir,
      '~/Argus/skills-user/collect-logs/scripts/collect.sh'
    )
    expect(fs.existsSync(mangled)).toBe(true)
    expect(skillAssetAt(argusHome, mangled, userHome)).toEqual({
      tier: 'user',
      skill: 'collect-logs',
      relPath: 'scripts/collect.sh'
    })
  })

  // The injected home is a test seam; production passes nothing and must land on os.homedir().
  it('defaults to os.homedir() when no home is injected', () => {
    seed(userSkillsDir(argusHome), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    const token = '~/Argus/skills-user/collect-logs/scripts/collect.sh'
    expect(skillAssetAt(argusHome, token)).toBeNull()
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(userHome)
    try {
      expect(skillAssetAt(argusHome, token)).toMatchObject({ skill: 'collect-logs' })
    } finally {
      spy.mockRestore()
    }
  })
})
