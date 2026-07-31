import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  seedSharedAssets,
  sharedSkillsDir,
  sharedReferencesDir,
  isNonPackTiered,
  resolveCoreSkillsDir,
  detectSkillCollisions
} from '../skillsDir'
import { frontmatterDescription, resolveSkills } from '../agent/skillsResolver'
import { defaultAgentAccess } from '../../../shared/agentAccess'
import { refTier } from '../refSync/refFrontmatter'

describe('seedSharedAssets', () => {
  it('seeds from multiple sources in order; later sources overwrite on collision', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
    const a = path.join(tmp, 'pack-a', 'skills')
    const b = path.join(tmp, 'pack-b', 'skills')
    fs.mkdirSync(path.join(a, 'shared-skill'), { recursive: true })
    fs.writeFileSync(path.join(a, 'shared-skill', 'SKILL.md'), 'from-a')
    fs.mkdirSync(path.join(a, 'only-a'), { recursive: true })
    fs.writeFileSync(path.join(a, 'only-a', 'SKILL.md'), 'a')
    fs.mkdirSync(path.join(b, 'shared-skill'), { recursive: true })
    fs.writeFileSync(path.join(b, 'shared-skill', 'SKILL.md'), 'from-b')
    const home = path.join(tmp, 'home')
    seedSharedAssets(home, { skills: [a, b], references: [] })
    const dest = sharedSkillsDir(home)
    expect(fs.readFileSync(path.join(dest, 'shared-skill', 'SKILL.md'), 'utf8')).toBe('from-b')
    expect(fs.readFileSync(path.join(dest, 'only-a', 'SKILL.md'), 'utf8')).toBe('a')
    expect(fs.existsSync(sharedReferencesDir(home))).toBe(true) // mkdir'd even with no sources
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('leaves extra files in the destination untouched (non-colliding files survive re-seed)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
    const src = path.join(tmp, 'pack', 'references')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'binlog-protocol.md'), 'packed')
    const home = path.join(tmp, 'home')
    const dest = sharedReferencesDir(home)
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'INDEX.md'), 'synced-runtime-data')
    seedSharedAssets(home, { skills: [], references: [src] })
    // The subject of this test: a destination file the seed source knows nothing about is left
    // exactly as it was — not rewritten, and not stamped.
    expect(fs.readFileSync(path.join(dest, 'INDEX.md'), 'utf8')).toBe('synced-runtime-data')
    // The pack's own file still lands; it now carries the bundled stamp (see the stamping tests).
    expect(fs.readFileSync(path.join(dest, 'binlog-protocol.md'), 'utf8')).toContain('packed')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it.each(['confluence', 'user', 'team-knowledge', 'hivemind'])(
    'a %s-tier reference survives re-seed even on name collision',
    (tier) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
      const src = path.join(tmp, 'pack', 'references')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'binlog-protocol.md'), 'packed')
      const home = path.join(tmp, 'home')
      const dest = sharedReferencesDir(home)
      fs.mkdirSync(dest, { recursive: true })
      const synced = `---\ntrust_tier: ${tier}\n---\nsynced body\n`
      fs.writeFileSync(path.join(dest, 'binlog-protocol.md'), synced)
      seedSharedAssets(home, { skills: [], references: [src] })
      expect(fs.readFileSync(path.join(dest, 'binlog-protocol.md'), 'utf8')).toBe(synced)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  )

  it('refreshes an untiered (pristine pack) reference on collision', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
    const src = path.join(tmp, 'pack', 'references')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'routing-flow.md'), 'packed v2')
    const home = path.join(tmp, 'home')
    const dest = sharedReferencesDir(home)
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'routing-flow.md'), 'packed v1')
    seedSharedAssets(home, { skills: [], references: [src] })
    // The subject: an untiered copy really is refreshed (v1 -> v2). `toContain` rather than
    // equality because the refreshed copy now carries the bundled stamp; that the OLD body is
    // gone is what "refreshes" means here, so assert that too.
    const out = fs.readFileSync(path.join(dest, 'routing-flow.md'), 'utf8')
    expect(out).toContain('packed v2')
    expect(out).not.toContain('packed v1')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // Pack-seeded references used to land UNTAGGED, and `isAssetEditable` treats an untagged
  // reference as hand-authored and therefore EDITABLE — so a bundled doc opened editable in the
  // editor, silently became `trust_tier: user` on first save (which also detached it from pack
  // re-seeding, via `isNonPackTiered`), and could then be permanently deleted with nothing left
  // to restore it. Stamping at seed time makes "bundled" a fact about the file rather than an
  // inference from where it happens to sit.
  it('stamps a seeded reference as bundled', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
    const src = path.join(tmp, 'pack', 'references')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'binlog-protocol.md'), '# packed body\n')
    const home = path.join(tmp, 'home')
    seedSharedAssets(home, { skills: [], references: [src] })
    const out = fs.readFileSync(path.join(sharedReferencesDir(home), 'binlog-protocol.md'), 'utf8')
    expect(refTier(out)).toBe('bundled')
    // The body must survive the stamp intact — this is the pack's content, not a rewrite.
    expect(out).toContain('# packed body')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // The backfill: existing homes already hold untagged pack copies. They are untiered, so the
  // seed refreshes them and the refreshed copy carries the stamp — no migration pass needed.
  it('re-stamps an existing untagged copy, backfilling homes seeded before stamping', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
    const src = path.join(tmp, 'pack', 'references')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'routing-flow.md'), 'packed v2\n')
    const home = path.join(tmp, 'home')
    const dest = sharedReferencesDir(home)
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'routing-flow.md'), 'packed v1 untagged\n')
    seedSharedAssets(home, { skills: [], references: [src] })
    const out = fs.readFileSync(path.join(dest, 'routing-flow.md'), 'utf8')
    expect(refTier(out)).toBe('bundled')
    expect(out).toContain('packed v2')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // A file the user claimed, or that Confluence owns, must never be stamped back to bundled —
  // that would re-lock an asset they deliberately took ownership of.
  it.each(['confluence', 'user', 'team-knowledge', 'hivemind'])(
    'never stamps over a %s-tier copy',
    (tier) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
      const src = path.join(tmp, 'pack', 'references')
      fs.mkdirSync(src, { recursive: true })
      fs.writeFileSync(path.join(src, 'binlog-protocol.md'), 'packed\n')
      const home = path.join(tmp, 'home')
      const dest = sharedReferencesDir(home)
      fs.mkdirSync(dest, { recursive: true })
      const owned = `---\ntrust_tier: ${tier}\n---\nowned body\n`
      fs.writeFileSync(path.join(dest, 'binlog-protocol.md'), owned)
      seedSharedAssets(home, { skills: [], references: [src] })
      expect(fs.readFileSync(path.join(dest, 'binlog-protocol.md'), 'utf8')).toBe(owned)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  )

  // References nest (see `listReferenceFiles`' walk), so a flat readdir would silently leave a
  // whole subtree untagged — still editable, still permanently deletable.
  it('stamps nested references too', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
    const root = path.join(tmp, 'pack', 'references')
    fs.mkdirSync(path.join(root, 'protocols'), { recursive: true })
    fs.writeFileSync(path.join(root, 'protocols', 'nested.md'), '# nested\n')
    const home = path.join(tmp, 'home')
    seedSharedAssets(home, { skills: [], references: [root] })
    const out = fs.readFileSync(
      path.join(sharedReferencesDir(home), 'protocols', 'nested.md'),
      'utf8'
    )
    expect(refTier(out)).toBe('bundled')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // Skills carry no trust_tier at all — a skill's tier is derived from which directory it
  // resolves out of. Stamping one would invent a field the skill reader does not use.
  it('does not stamp seeded skills', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
    const src = path.join(tmp, 'pack', 'skills')
    fs.mkdirSync(path.join(src, 'rca'), { recursive: true })
    fs.writeFileSync(path.join(src, 'rca', 'SKILL.md'), '# rca\n')
    const home = path.join(tmp, 'home')
    seedSharedAssets(home, { skills: [src], references: [] })
    expect(fs.readFileSync(path.join(sharedSkillsDir(home), 'rca', 'SKILL.md'), 'utf8')).toBe(
      '# rca\n'
    )
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('skills seeding always refreshes, even when a skill file carries a trust tier', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
    const src = path.join(tmp, 'pack', 'skills')
    fs.mkdirSync(path.join(src, 'rca'), { recursive: true })
    fs.writeFileSync(path.join(src, 'rca', 'SKILL.md'), 'packed v2')
    const home = path.join(tmp, 'home')
    const dest = sharedSkillsDir(home)
    fs.mkdirSync(path.join(dest, 'rca'), { recursive: true })
    fs.writeFileSync(path.join(dest, 'rca', 'SKILL.md'), '---\ntrust_tier: user\n---\nedited\n')
    seedSharedAssets(home, { skills: [src], references: [] })
    expect(fs.readFileSync(path.join(dest, 'rca', 'SKILL.md'), 'utf8')).toBe('packed v2')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('skips missing sources and never self-copies (home == source dir)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
    const home = path.join(tmp, 'home')
    const skills = path.join(home, 'skills')
    fs.mkdirSync(skills, { recursive: true })
    fs.writeFileSync(path.join(skills, 'keep.md'), 'x')
    expect(() =>
      seedSharedAssets(home, { skills: [path.join(tmp, 'missing'), skills], references: [] })
    ).not.toThrow()
    expect(fs.readFileSync(path.join(skills, 'keep.md'), 'utf8')).toBe('x')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('documented skill-source order: packs < core < env override (later wins)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sa-'))
    const mk = (root: string, body: string): string => {
      fs.mkdirSync(path.join(root, 'contribute-back'), { recursive: true })
      fs.writeFileSync(path.join(root, 'contribute-back', 'SKILL.md'), body)
      return root
    }
    const pack = mk(path.join(tmp, 'pack', 'skills'), 'from-pack')
    const core = mk(path.join(tmp, 'core-skills'), 'from-core')
    const env = mk(path.join(tmp, 'env-override'), 'from-env')
    const home = path.join(tmp, 'home')

    // core after packs: a pack cannot silently replace a core skill
    seedSharedAssets(home, { skills: [pack, core], references: [] })
    const dest = path.join(sharedSkillsDir(home), 'contribute-back', 'SKILL.md')
    expect(fs.readFileSync(dest, 'utf8')).toBe('from-core')

    // env override last: dev dir still beats core
    seedSharedAssets(home, { skills: [pack, core, env], references: [] })
    expect(fs.readFileSync(dest, 'utf8')).toBe('from-env')
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('detectSkillCollisions', () => {
  const mk = (root: string, ...names: string[]): string => {
    for (const n of names) {
      fs.mkdirSync(path.join(root, n), { recursive: true })
      fs.writeFileSync(path.join(root, n, 'SKILL.md'), `---\nname: ${n}\n---\nbody\n`)
    }
    return root
  }

  it('reports a name two packs both provide, naming the winner and the shadowed source', () => {
    // seedSharedAssets flat-copies every source into ONE dir with later-wins semantics, so
    // the loser vanishes before resolveSkills ever scans — its `shadows[]` cannot see it.
    // Detection has to happen against the sources, not the destination.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-col-'))
    const a = mk(path.join(tmp, 'pack-a'), 'analyze-logs', 'only-a')
    const b = mk(path.join(tmp, 'pack-b'), 'analyze-logs')

    expect(detectSkillCollisions([a, b])).toEqual([
      { name: 'analyze-logs', winner: b, shadowed: [a] }
    ])
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('is silent when every skill name is unique', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-col-'))
    const a = mk(path.join(tmp, 'pack-a'), 'alpha')
    const b = mk(path.join(tmp, 'pack-b'), 'beta')
    expect(detectSkillCollisions([a, b])).toEqual([])
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('tolerates missing sources and ignores dirs without a SKILL.md', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-col-'))
    const a = mk(path.join(tmp, 'pack-a'), 'alpha')
    fs.mkdirSync(path.join(a, 'not-a-skill'), { recursive: true }) // no SKILL.md
    expect(detectSkillCollisions([path.join(tmp, 'missing'), a])).toEqual([])
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('collects every shadowed source when three sources claim one name', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-col-'))
    const a = mk(path.join(tmp, 'pack-a'), 'dup')
    const b = mk(path.join(tmp, 'pack-b'), 'dup')
    const c = mk(path.join(tmp, 'core'), 'dup')
    expect(detectSkillCollisions([a, b, c])).toEqual([{ name: 'dup', winner: c, shadowed: [a, b] }])
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('isNonPackTiered (reap guard)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tier-'))
  })

  it('is false for an untiered (pristine pack) reference', () => {
    const f = path.join(tmp, 'plain.md')
    fs.writeFileSync(f, '# just a pack reference, no frontmatter tier\n')
    expect(isNonPackTiered(f)).toBe(false)
  })

  it('is true for a hivemind-tiered reference (protected)', () => {
    const f = path.join(tmp, 'synced.md')
    fs.writeFileSync(f, '---\ntrust_tier: hivemind\n---\nsynced body\n')
    expect(isNonPackTiered(f)).toBe(true)
  })

  it('is false for a missing file', () => {
    expect(isNonPackTiered(path.join(tmp, 'nope.md'))).toBe(false)
  })
})

describe('resolveCoreSkillsDir', () => {
  let tmp2: string
  beforeEach(() => {
    tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-core-skills-'))
  })
  afterEach(() => fs.rmSync(tmp2, { recursive: true, force: true }))

  it('uses the packaged path only when it actually exists there', () => {
    const resources = path.join(tmp2, 'resources')
    fs.mkdirSync(path.join(resources, 'core-skills'), { recursive: true })
    expect(resolveCoreSkillsDir(path.join(tmp2, 'app'), resources)).toBe(
      path.join(resources, 'core-skills')
    )
  })

  it('falls back to <appRoot>/resources/core-skills when resourcesPath lacks it (dev)', () => {
    // resourcesPath is set (as in dev, pointing at electron dist) but has no core-skills
    const electronDist = path.join(tmp2, 'electron-dist', 'resources')
    fs.mkdirSync(electronDist, { recursive: true })
    const appRoot = path.join(tmp2, 'app')
    expect(resolveCoreSkillsDir(appRoot, electronDist)).toBe(
      path.join(appRoot, 'resources', 'core-skills')
    )
  })

  it('falls back to the source dir when resourcesPath is undefined', () => {
    const appRoot = path.join(tmp2, 'app')
    expect(resolveCoreSkillsDir(appRoot, undefined)).toBe(
      path.join(appRoot, 'resources', 'core-skills')
    )
  })
})

describe('core-skills assets', () => {
  // the real in-repo asset dir (what resolveCoreSkillsDir returns in dev)
  const coreDir = path.resolve(__dirname, '../../../../resources/core-skills')

  it('ships contribute-back with a parseable single-line description', () => {
    const desc = frontmatterDescription(path.join(coreDir, 'contribute-back'))
    expect(desc).toMatch(/reusable/i)
    expect(desc).toMatch(/proposal/i)
  })

  it('seeds into the bundled tier and resolves as an enabled bundled skill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-core-seed-'))
    const home = path.join(tmp, 'home')
    seedSharedAssets(home, { skills: [coreDir], references: [] })
    const cb = resolveSkills(home, defaultAgentAccess()).find((s) => s.name === 'contribute-back')
    expect(cb).toBeDefined()
    expect(cb!.tier).toBe('bundled')
    expect(cb!.enabled).toBe(true)
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
