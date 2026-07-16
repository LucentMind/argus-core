import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  seedSharedAssets,
  sharedSkillsDir,
  sharedReferencesDir,
  isNonPackTiered,
  resolveCoreSkillsDir
} from '../skillsDir'

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
    expect(fs.readFileSync(path.join(dest, 'INDEX.md'), 'utf8')).toBe('synced-runtime-data')
    expect(fs.readFileSync(path.join(dest, 'binlog-protocol.md'), 'utf8')).toBe('packed')
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
    expect(fs.readFileSync(path.join(dest, 'routing-flow.md'), 'utf8')).toBe('packed v2')
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
