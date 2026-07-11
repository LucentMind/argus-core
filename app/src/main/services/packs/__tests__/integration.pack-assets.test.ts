import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { seedPacks, packsDir } from '../paths'
import { PackRegistry } from '../registry'
import { seedSharedAssets, sharedSkillsDir, sharedReferencesDir } from '../../skillsDir'
import { resolveSkills } from '../../agent/skillsResolver'
import { defaultAgentAccess } from '../../../../shared/agentAccess'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-packassets-'))
  delete process.env.ARGUS_PACKS_DIR
  delete process.env.ARGUS_PACKS_SRC
})
afterEach(() => {
  delete process.env.ARGUS_PACKS_DIR
  delete process.env.ARGUS_PACKS_SRC
  fs.rmSync(home, { recursive: true, force: true })
})

describe('pack assets end-to-end (real sample pack)', () => {
  it('seeds pack skills + references into the shared dirs and resolves as bundled tier', () => {
    const repoPacks = path.resolve(process.cwd(), '..', 'packs')
    seedPacks(home, repoPacks)
    const reg = PackRegistry.load(packsDir(home))
    expect(reg.errors()).toEqual([])
    seedSharedAssets(home, { skills: reg.skillsSources(), references: reg.referencesSources() })

    expect(fs.existsSync(path.join(sharedSkillsDir(home), 'analyze-binlog', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(sharedReferencesDir(home), 'binlog-protocol.md'))).toBe(true)

    const skills = resolveSkills(home, defaultAgentAccess())
    const binlog = skills.find((s) => s.name === 'analyze-binlog')
    expect(binlog?.tier).toBe('bundled')
    expect(binlog?.enabled).toBe(true)
    expect(binlog?.description.length).toBeGreaterThan(0) // frontmatter still parses post-move
  })
})
