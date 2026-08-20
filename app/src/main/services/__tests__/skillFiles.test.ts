import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteSkillFile,
  listSkillFiles,
  readSkillFile,
  renameSkillFile,
  writeSkillFile
} from '../skillFiles'
import { hivemindSkillsDir, userSkillsDir } from '../paths'

let home: string

function seed(root: string, skill: string, rel: string, body: string): void {
  const abs = path.join(root, skill, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-skill-files-'))
  seed(userSkillsDir(home), 'collect-logs', 'SKILL.md', '---\nname: collect-logs\n---\nbody\n')
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('listSkillFiles', () => {
  it('lists siblings with POSIX paths, and never SKILL.md itself', () => {
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', '#!/bin/sh\necho hi\n')
    seed(userSkillsDir(home), 'collect-logs', 'templates/report.md', '# Report\n')
    const files = listSkillFiles(home, 'collect-logs')
    expect(files.map((f) => f.relPath).sort()).toEqual([
      'scripts/collect.sh',
      'templates/report.md'
    ])
    expect(files.every((f) => !f.relPath.includes('\\'))).toBe(true)
  })

  it('flags an executable by the shared predicate, extension or shebang', () => {
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    seed(userSkillsDir(home), 'collect-logs', 'templates/hook.md', '#!/bin/sh\necho hi\n')
    seed(userSkillsDir(home), 'collect-logs', 'templates/report.md', '# Report\n')
    const by = new Map(listSkillFiles(home, 'collect-logs').map((f) => [f.relPath, f.executable]))
    expect(by.get('scripts/collect.sh')).toBe(true)
    expect(by.get('templates/hook.md')).toBe(true)
    expect(by.get('templates/report.md')).toBe(false)
  })

  it('reports the tier of the skill the files came from', () => {
    seed(hivemindSkillsDir(home), 'team-skill', 'SKILL.md', '---\nname: team-skill\n---\nx\n')
    seed(hivemindSkillsDir(home), 'team-skill', 'run.sh', 'echo hi\n')
    expect(listSkillFiles(home, 'team-skill')[0]).toMatchObject({
      relPath: 'run.sh',
      tier: 'hivemind',
      editable: false
    })
  })

  // The resolver's precedence, not a second copy of it: a user copy shadows hivemind entirely.
  it('lists only the winning tier when a skill exists in two', () => {
    seed(hivemindSkillsDir(home), 'collect-logs', 'SKILL.md', '---\nname: collect-logs\n---\nx\n')
    seed(hivemindSkillsDir(home), 'collect-logs', 'only-in-hive.sh', 'echo hi\n')
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    expect(listSkillFiles(home, 'collect-logs').map((f) => f.relPath)).toEqual([
      'scripts/collect.sh'
    ])
  })

  it('skips the swap directories acceptProposal leaves behind', () => {
    seed(userSkillsDir(home), '.staging-collect-logs', 'x.sh', 'echo hi\n')
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    expect(listSkillFiles(home, '.staging-collect-logs')).toEqual([])
  })

  it('returns an empty list for a skill with no siblings, and for an unknown skill', () => {
    expect(listSkillFiles(home, 'collect-logs')).toEqual([])
    expect(listSkillFiles(home, 'ghost')).toEqual([])
  })
})

describe('readSkillFile', () => {
  it('returns the content and its hash', () => {
    const body = '#!/bin/sh\necho hi\n'
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', body)
    const r = readSkillFile(home, 'collect-logs', 'scripts/collect.sh')
    expect(r).toMatchObject({ content: body, tier: 'user', editable: true, executable: true })
    expect(r?.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns null for a missing file and for an illegal path', () => {
    expect(readSkillFile(home, 'collect-logs', 'ghost.sh')).toBeNull()
    expect(readSkillFile(home, 'collect-logs', '../escape.sh')).toBeNull()
  })
})

describe('writeSkillFile', () => {
  it('creates a new sibling and returns its hash', () => {
    const r = writeSkillFile(home, 'collect-logs', 'scripts/new.sh', 'echo hi\n', null)
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.executable).toBe(true)
    expect(
      fs.readFileSync(path.join(userSkillsDir(home), 'collect-logs/scripts/new.sh'), 'utf8')
    ).toBe('echo hi\n')
  })

  it('refuses a write whose baseHash does not match what is on disk', () => {
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    expect(() =>
      writeSkillFile(home, 'collect-logs', 'scripts/collect.sh', 'echo bye\n', 'f'.repeat(64))
    ).toThrow(/changed on disk/i)
  })

  // The renderer's disabled button is an affordance; this is the boundary.
  it('refuses a write to a skill whose winning tier is not user', () => {
    seed(hivemindSkillsDir(home), 'team-skill', 'SKILL.md', '---\nname: team-skill\n---\nx\n')
    expect(() => writeSkillFile(home, 'team-skill', 'run.sh', 'echo hi\n', null)).toThrow(
      /read-only|not yours|hivemind/i
    )
  })

  it('refuses an illegal path with the shared rule message', () => {
    expect(() => writeSkillFile(home, 'collect-logs', '../escape.sh', 'x\n', null)).toThrow()
    expect(() => writeSkillFile(home, 'collect-logs', 'SKILL.md', 'x\n', null)).toThrow()
    expect(() => writeSkillFile(home, 'collect-logs', 'a/b/c/d.sh', 'x\n', null)).toThrow()
  })

  it('refuses a file over the per-file byte cap', () => {
    const big = 'x'.repeat(64 * 1024 + 1)
    expect(() => writeSkillFile(home, 'collect-logs', 'big.txt', big, null)).toThrow(/limit/i)
  })

  // Adding the 33rd file must fail; overwriting one of 32 must not.
  it('enforces the file-count cap on create but not on overwrite', () => {
    for (let i = 0; i < 32; i++) seed(userSkillsDir(home), 'collect-logs', `f${i}.txt`, 'x\n')
    expect(() => writeSkillFile(home, 'collect-logs', 'f32.txt', 'x\n', null)).toThrow(/at most/i)
    const existing = readSkillFile(home, 'collect-logs', 'f0.txt')!
    expect(() => writeSkillFile(home, 'collect-logs', 'f0.txt', 'y\n', existing.hash)).not.toThrow()
  })

  // I4: on the case-insensitive filesystems this app ships on (Windows, macOS), `Scripts/Run.sh`
  // and `scripts/run.sh` are the SAME file. Before the fix, `writeSkillFile` matched `prior` with
  // an exact-case compare, so a create attempt (`baseHash: null`) under different casing found no
  // `prior`, never probed disk, and the "already exists" guard never fired — `fs.writeFileSync`
  // silently OVERWROTE the existing file's content with the caller's, who believed they were
  // creating a new one (this is exactly what the dock's Add File dialog does: it always passes
  // `baseHash: null`).
  it('refuses to create a file that collides case-insensitively with an existing sibling', () => {
    seed(userSkillsDir(home), 'collect-logs', 'scripts/run.sh', 'echo original\n')
    expect(() =>
      writeSkillFile(home, 'collect-logs', 'Scripts/Run.sh', 'echo clobbered\n', null)
    ).toThrow(/already exists/i)
    // The original file must be untouched — not silently overwritten under the new casing.
    expect(
      fs.readFileSync(path.join(userSkillsDir(home), 'collect-logs/scripts/run.sh'), 'utf8')
    ).toBe('echo original\n')
  })

  // I5: a stale tab holds a non-null baseHash from when it opened an EXISTING file. If that file
  // was renamed or deleted elsewhere in the meantime, `onDisk` comes back null either way — before
  // the fix that fell through BOTH the "already exists" guard (baseHash isn't null) and the
  // "changed on disk" guard (onDisk is null, so there is nothing to compare the hash against),
  // straight to `fs.writeFileSync`, which silently RECREATES the file at the old path.
  it('refuses a save with a non-null baseHash when the file is no longer on disk', () => {
    const existing = writeSkillFile(home, 'collect-logs', 'scripts/gone.sh', 'echo hi\n', null)
    fs.rmSync(path.join(userSkillsDir(home), 'collect-logs/scripts/gone.sh'))
    expect(() =>
      writeSkillFile(home, 'collect-logs', 'scripts/gone.sh', 'echo new\n', existing.hash)
    ).toThrow(/deleted or renamed/i)
    expect(
      fs.existsSync(path.join(userSkillsDir(home), 'collect-logs/scripts/gone.sh'))
    ).toBe(false)
  })
})

describe('deleteSkillFile and renameSkillFile', () => {
  it('deletes a sibling', () => {
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    deleteSkillFile(home, 'collect-logs', 'scripts/collect.sh')
    expect(listSkillFiles(home, 'collect-logs')).toEqual([])
  })

  it('renames a sibling, validating the destination', () => {
    seed(userSkillsDir(home), 'collect-logs', 'scripts/collect.sh', 'echo hi\n')
    renameSkillFile(home, 'collect-logs', 'scripts/collect.sh', 'scripts/gather.sh')
    expect(listSkillFiles(home, 'collect-logs').map((f) => f.relPath)).toEqual([
      'scripts/gather.sh'
    ])
    expect(() =>
      renameSkillFile(home, 'collect-logs', 'scripts/gather.sh', '../escape.sh')
    ).toThrow()
  })

  it('refuses to rename onto an existing file', () => {
    seed(userSkillsDir(home), 'collect-logs', 'a.sh', 'echo a\n')
    seed(userSkillsDir(home), 'collect-logs', 'b.sh', 'echo b\n')
    expect(() => renameSkillFile(home, 'collect-logs', 'a.sh', 'b.sh')).toThrow(/exists/i)
  })

  it('refuses both on a non-user tier', () => {
    seed(hivemindSkillsDir(home), 'team-skill', 'SKILL.md', '---\nname: team-skill\n---\nx\n')
    seed(hivemindSkillsDir(home), 'team-skill', 'run.sh', 'echo hi\n')
    expect(() => deleteSkillFile(home, 'team-skill', 'run.sh')).toThrow()
    expect(() => renameSkillFile(home, 'team-skill', 'run.sh', 'other.sh')).toThrow()
  })
})
