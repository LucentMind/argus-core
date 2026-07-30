import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EditorWindowStore } from '../editorWindowStore'

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
