import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoutineStore } from '../store'
import { routinesPath } from '../../paths'

let home: string
let store: RoutineStore | null = null

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rstore-'))
})
afterEach(() => {
  store?.close()
  store = null
  fs.rmSync(home, { recursive: true, force: true })
})

describe('RoutineStore', () => {
  it('starts empty, upserts, persists to disk, and reads back', () => {
    store = new RoutineStore(home)
    expect(store.list()).toEqual([])
    store.upsert({ id: 'sweep', name: 'Sweep', prompt: 'sweep the cases' })
    expect(store.get('sweep')?.timeoutMs).toBe(600_000)
    const onDisk = JSON.parse(fs.readFileSync(routinesPath(home), 'utf8'))
    expect(onDisk.routines).toHaveLength(1)
    // A second store over the same home sees the persisted routine.
    const reread = new RoutineStore(home)
    expect(reread.get('sweep')?.name).toBe('Sweep')
    reread.close()
  })

  it('upsert replaces by id and remove deletes', () => {
    store = new RoutineStore(home)
    store.upsert({ id: 'sweep', name: 'Sweep', prompt: 'v1' })
    store.upsert({ id: 'sweep', name: 'Sweep', prompt: 'v2' })
    expect(store.list()).toHaveLength(1)
    expect(store.get('sweep')?.prompt).toBe('v2')
    store.remove('sweep')
    expect(store.list()).toEqual([])
  })

  it('keeps defaults + loadError on a broken file, and an explicit save clears it', () => {
    fs.mkdirSync(path.dirname(routinesPath(home)), { recursive: true })
    fs.writeFileSync(routinesPath(home), '{not json', 'utf8')
    store = new RoutineStore(home)
    expect(store.list()).toEqual([])
    expect(store.loadError()).toBeTruthy()
    store.upsert({ id: 'a', name: 'A', prompt: 'p' })
    expect(store.loadError()).toBeNull()
  })

  it('rejects invalid routines', () => {
    store = new RoutineStore(home)
    expect(() => store!.upsert({ id: 'Bad Id', name: 'x', prompt: 'y' })).toThrow()
  })
})
