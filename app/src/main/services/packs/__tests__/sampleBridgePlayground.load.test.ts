import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { loadPacks } from '../loader'
import { seededPacksDir } from '../paths'

// packs/__tests__ → up 5 = app/ (seededPacksDir → <repo>/packs), same as panels/__tests__.
const packsSrc = seededPacksDir(path.resolve(__dirname, '../../../../..'))

describe('sample-bridge-playground pack loads clean', () => {
  it('loads with the rest of the shipped pack set and grants the write/collab verbs', () => {
    const { packs, errors } = loadPacks(packsSrc)
    expect(errors).toEqual([])
    const pg = packs.find((p) => p.manifest.id === 'sample-bridge-playground')
    expect(pg).toBeDefined()
    const win = pg!.manifest.windows[0]
    expect(win.permissions).toContain('cite')
    expect(win.permissions).toContain('emitFinding')
    expect(win.permissions).toContain('sendToAgent')
  })
})
