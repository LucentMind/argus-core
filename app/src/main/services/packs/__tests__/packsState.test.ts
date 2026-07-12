import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PacksStateStore } from '../packsState'
import { packsStatePath } from '../../paths'

let home: string
let store: PacksStateStore
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pstate-'))
  store = new PacksStateStore(home)
})
afterEach(() => {
  store.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('PacksStateStore', () => {
  it('starts empty', () => {
    expect(store.list()).toEqual({})
    expect(store.get('navigation')).toBeUndefined()
  })

  it('sets and reads id -> version, persisting under config/packs-state.json', () => {
    store.set('navigation', '1.4.0')
    expect(store.get('navigation')).toBe('1.4.0')
    expect(store.list()).toEqual({ navigation: '1.4.0' })
    const onDisk = JSON.parse(fs.readFileSync(packsStatePath(home), 'utf8'))
    expect(onDisk.packs.navigation).toBe('1.4.0')
  })

  it('overwrites a version and removes an id', () => {
    store.set('navigation', '1.4.0')
    store.set('navigation', '1.5.0')
    expect(store.get('navigation')).toBe('1.5.0')
    store.remove('navigation')
    expect(store.get('navigation')).toBeUndefined()
    expect(store.list()).toEqual({})
  })

  it('reads state written by a previous instance', () => {
    store.set('code-graph', '0.1.0')
    store.close()
    const reopened = new PacksStateStore(home)
    expect(reopened.get('code-graph')).toBe('0.1.0')
    reopened.close()
  })
})
