import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentAccessStore } from '../agentAccess'
import { agentAccessPath } from '../paths'

let tmp: string, argusHome: string, store: AgentAccessStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-aa-'))
  argusHome = path.join(tmp, 'home')
  store = new AgentAccessStore(argusHome)
})

afterEach(() => {
  store.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AgentAccessStore', () => {
  it('starts with defaults when file is absent', () => {
    expect(store.get().skills).toEqual({})
    expect(store.payload().loadError).toBeNull()
  })

  it('patch persists false overrides and drops true entries (sparse file)', () => {
    store.patch({ skills: { 'bundled/rca': false }, memory: { 'tile-blocks': false } })
    store.patch({ memory: { 'tile-blocks': true } }) // re-enable
    const onDisk = JSON.parse(fs.readFileSync(agentAccessPath(argusHome), 'utf8'))
    expect(onDisk.skills).toEqual({ 'bundled/rca': false })
    expect(onDisk.memory).toEqual({}) // true entry stripped
    expect(store.get().memory['tile-blocks']).not.toBe(false)
  })

  it('broken file yields defaults + loadError, and an explicit patch clears it', () => {
    store.close()
    fs.mkdirSync(path.dirname(agentAccessPath(argusHome)), { recursive: true })
    fs.writeFileSync(agentAccessPath(argusHome), '{not json')
    store = new AgentAccessStore(argusHome)
    expect(store.payload().loadError).not.toBeNull()
    expect(store.get().skills).toEqual({})
    store.patch({ skills: { 'bundled/rca': false } })
    expect(store.payload().loadError).toBeNull()
  })
})
