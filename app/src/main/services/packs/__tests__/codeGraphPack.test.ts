import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { loadPacks } from '../loader'
import { resolvePacksSource } from '../paths'

// The dev pack source is <repo>/packs (paths.ts). app/ is the vitest cwd.
const packsSrc = resolvePacksSource(path.resolve(__dirname, '../../../../..'))

describe('code-graph pack', () => {
  it('loads with a graphify exe declaration and a skill dir', () => {
    const { packs, errors } = loadPacks(packsSrc)
    expect(errors).toEqual([])
    const pack = packs.find((p) => p.id === 'code-graph')
    expect(pack).toBeDefined()
    const bin = pack!.manifest.binaries.find((b) => b.id === 'graphify')
    expect(bin).toMatchObject({
      kind: 'exe',
      names: ['graphify'],
      envVar: 'ARGUS_GRAPHIFY',
      settingsKey: 'graphifyBin',
      versionArgs: ['--version'],
      pathProbeArgs: ['--version']
    })
    expect(bin!.fixHint).toContain('graphifyy')
    expect(pack!.skillsDir).not.toBeNull()
    expect(fs.existsSync(path.join(pack!.skillsDir!, 'code-graph', 'SKILL.md'))).toBe(true)
  })
})
