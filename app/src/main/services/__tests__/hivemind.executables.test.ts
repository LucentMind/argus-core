import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executableAssetsOf } from '../hivemind'
import { userSkillsDir } from '../paths'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-hive-exec-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function install(name: string, files: Record<string, string>): void {
  const dir = path.join(userSkillsDir(home), name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: d\n---\n')
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
}

describe('executableAssetsOf', () => {
  it('lists executables by extension and by shebang, sorted', () => {
    install('collect-logs', {
      'scripts/collect.sh': 'echo hi\n',
      'bin/run': '#!/usr/bin/env bash\n',
      'templates/report.md': '# Report\n'
    })
    expect(executableAssetsOf(home, 'collect-logs')).toEqual(['bin/run', 'scripts/collect.sh'])
  })

  it('returns [] for a skill with no executables', () => {
    install('prose-only', { 'templates/report.md': '# Report\n' })
    expect(executableAssetsOf(home, 'prose-only')).toEqual([])
  })

  it('returns [] for a skill that does not exist', () => {
    expect(executableAssetsOf(home, 'nope')).toEqual([])
  })

  it('never counts SKILL.md itself', () => {
    install('body-only', {})
    expect(executableAssetsOf(home, 'body-only')).toEqual([])
  })
})
