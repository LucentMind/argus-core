import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedSharedDirs, listSkills, sharedSkillsDir } from '../skillsDir'

describe('skillsDir', () => {
  it('seeds shared dirs and lists skill frontmatter', () => {
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
    expect(listSkills(home)).toEqual([
      { name: 'analyze-applog', description: 'Analyze an Android applog file.' }
    ])
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
