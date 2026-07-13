import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { PackRegistry } from '../registry'

// __tests__ → up 6 = repo root, then /packs (same resolution as
// sampleTextViewerPack.test.ts / sampleBridgePlayground.load.test.ts, which go
// up 5 to app/ via seededPacksDir(path.resolve(__dirname, '../../../../..'))
// and then one more '..' inside seededPacksDir to reach repo-root/packs).
const REPO_PACKS = path.resolve(__dirname, '../../../../../../packs')

describe('sample-external-app pack loads (3c)', () => {
  it('registers an externalApp window with ping/echo commands', () => {
    const reg = PackRegistry.load(REPO_PACKS)
    const decls = reg.windowDecls().filter((w) => w.packId === 'sample-external-app')
    expect(decls).toHaveLength(1)
    const w = decls[0].decl
    expect(w.kind).toBe('externalApp')
    expect(w.runtime).toBe('node')
    expect(w.control?.channel).toBe('stdio')
    expect(w.commands.map((c) => c.id).sort()).toEqual(['echo', 'ping'])
  })
})
