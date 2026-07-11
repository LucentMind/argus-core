import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedSharedAssets, sharedSkillsDir, sharedReferencesDir } from '../skillsDir'

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

  it('leaves extra files in the destination untouched (synced refs survive re-seed)', () => {
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
})
