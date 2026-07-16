import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { loadPacks } from '../loader'
import { PackRegistry } from '../registry'
import { seededPacksDir } from '../paths'

// __dirname = app/src/main/services/packs/__tests__ → up 5 = app/ ; seededPacksDir → <repo>/packs
const packsSrc = seededPacksDir(path.resolve(__dirname, '../../../../..'))

describe('sample-text-viewer pack', () => {
  it('loads with no errors and declares one webPanel handling "text"', () => {
    const { packs, errors } = loadPacks(packsSrc)
    expect(errors).toEqual([])
    const pack = packs.find((p) => p.id === 'sample-text-viewer')
    expect(pack).toBeTruthy()
    expect(pack!.uiDir).toBeTruthy()
    const win = pack!.manifest.windows.find((w) => w.id === 'text-viewer')!
    expect(win.kind).toBe('webPanel')
    expect(win.handles).toEqual(['text'])
    expect(win.permissions).toEqual(['getCaseContext', 'requestEvidence', 'readEvidence'])
    expect(win.network).toEqual([])
  })

  it('surfaces the window via windowDecls with its entry files present on disk', () => {
    const reg = new PackRegistry(loadPacks(packsSrc).packs)
    const w = reg
      .windowDecls()
      .find((d) => d.packId === 'sample-text-viewer' && d.decl.id === 'text-viewer')
    expect(w).toBeTruthy()
    for (const f of ['index.html', 'app.js', 'app.css']) {
      // webPanel-only; Task 6 routes externalApp before this
      expect(fs.existsSync(path.join(w!.uiDir as string, 'text-viewer', f))).toBe(true)
    }
  })
})
