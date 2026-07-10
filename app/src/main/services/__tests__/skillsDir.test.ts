import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedSharedDirs, sharedSkillsDir } from '../skillsDir'

describe('skillsDir', () => {
  it('seeds shared dirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sk-'))
    const src = path.join(tmp, 'src-skills', 'analyze-applog')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(
      path.join(src, 'SKILL.md'),
      `---\nname: analyze-applog\ndescription: Analyze an Android applog file.\n---\n\n# body\n`
    )
    const refSrc = path.join(tmp, 'src-refs')
    fs.mkdirSync(refSrc, { recursive: true })
    const home = path.join(tmp, 'home')
    seedSharedDirs(home, { skills: path.join(tmp, 'src-skills'), references: refSrc })
    expect(fs.existsSync(path.join(sharedSkillsDir(home), 'analyze-applog', 'SKILL.md'))).toBe(true)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('is a no-op when source and destination are the same directory', () => {
    // happens when argusHome is the repo checkout itself (dev default ~/Argus)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sk-'))
    const home = path.join(tmp, 'home')
    const skills = path.join(home, 'skills')
    fs.mkdirSync(skills, { recursive: true })
    fs.writeFileSync(path.join(skills, 'keep.md'), 'x')
    expect(() =>
      seedSharedDirs(home, { skills, references: path.join(home, 'references') })
    ).not.toThrow()
    expect(fs.readFileSync(path.join(skills, 'keep.md'), 'utf8')).toBe('x')
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
