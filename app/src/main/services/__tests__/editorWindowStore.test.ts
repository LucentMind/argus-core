import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EditorWindowStore } from '../editorWindowStore'
import type { PersistedTabs } from '../../../shared/editorIpc'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-editorwin-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('EditorWindowStore', () => {
  it('returns null before anything has been saved', () => {
    expect(new EditorWindowStore(home).load()).toBeNull()
  })

  it('round-trips bounds through disk', () => {
    const store = new EditorWindowStore(home)
    store.save({ x: 10, y: 20, width: 1100, height: 780 })
    expect(new EditorWindowStore(home).load()).toEqual({
      x: 10,
      y: 20,
      width: 1100,
      height: 780
    })
  })

  it('writes into config/editor-window.json', () => {
    new EditorWindowStore(home).save({ x: 1, y: 2, width: 800, height: 600 })
    const raw = fs.readFileSync(path.join(home, 'config', 'editor-window.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual({ bounds: { x: 1, y: 2, width: 800, height: 600 } })
  })

  it('returns null rather than throwing when the file is corrupt', () => {
    const file = path.join(home, 'config', 'editor-window.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json', 'utf8')
    expect(new EditorWindowStore(home).load()).toBeNull()
  })

  it('returns null when the persisted shape is not a complete rect', () => {
    const file = path.join(home, 'config', 'editor-window.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ bounds: { x: 1, y: 2 } }), 'utf8')
    expect(new EditorWindowStore(home).load()).toBeNull()
  })
})

describe('tab set', () => {
  const TABS: PersistedTabs = {
    tabs: [
      { kind: 'skill', name: 'a', mode: 'edit', view: { line: 3, col: 1, scrollFraction: 0.2 } },
      { kind: 'reference', name: 'b.md', mode: 'edit', view: null }
    ],
    activeIndex: 1
  }

  it('round-trips a tab set', () => {
    const store = new EditorWindowStore(home)
    store.saveTabs(TABS)
    expect(new EditorWindowStore(home).loadTabs()).toEqual(TABS)
  })

  it('reports no tab set before one is written', () => {
    expect(new EditorWindowStore(home).loadTabs()).toBeNull()
  })

  // The two live in one file. Writing either must not erase the other, or the window would
  // forget its position every time a tab moved.
  it('keeps bounds when tabs are written', () => {
    const store = new EditorWindowStore(home)
    store.save({ x: 1, y: 2, width: 800, height: 600 })
    store.saveTabs(TABS)
    expect(new EditorWindowStore(home).load()).toEqual({ x: 1, y: 2, width: 800, height: 600 })
  })

  it('keeps tabs when bounds are written', () => {
    const store = new EditorWindowStore(home)
    store.saveTabs(TABS)
    store.save({ x: 1, y: 2, width: 800, height: 600 })
    expect(new EditorWindowStore(home).loadTabs()).toEqual(TABS)
  })

  it('round-trips an empty tab set', () => {
    const store = new EditorWindowStore(home)
    store.saveTabs({ tabs: [], activeIndex: -1 })
    expect(new EditorWindowStore(home).loadTabs()).toEqual({ tabs: [], activeIndex: -1 })
  })

  // The file is on disk and a user can edit it. A malformed entry must not take the window down
  // on launch — the same defensive read `isBounds` already does for bounds.
  it('rejects a malformed tab set rather than returning junk', () => {
    const store = new EditorWindowStore(home)
    store.saveTabs(TABS)
    fs.writeFileSync(
      path.join(home, 'config', 'editor-window.json'),
      JSON.stringify({ tabs: { tabs: [{ kind: 'skill' }], activeIndex: 0 } })
    )
    expect(new EditorWindowStore(home).loadTabs()).toBeNull()
  })

  it('rejects a tab set that is not an object', () => {
    const file = path.join(home, 'config', 'editor-window.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ tabs: 'nope' }))
    expect(new EditorWindowStore(home).loadTabs()).toBeNull()
  })
})
