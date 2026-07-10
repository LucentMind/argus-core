import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConnectorRegistry } from '../connectors'
import { mcpServersPath } from '../paths'

let tmp: string, argusHome: string, reg: ConnectorRegistry

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-connreg-'))
  argusHome = path.join(tmp, 'home')
})

afterEach(() => {
  reg?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ConnectorRegistry', () => {
  it('absent file → empty registry, no loadError', () => {
    reg = new ConnectorRegistry(argusHome)
    expect(reg.get()).toEqual({})
    expect(reg.loadError()).toBeNull()
  })

  it('patch adds an instance, fills defaults, persists, notifies', () => {
    reg = new ConnectorRegistry(argusHome)
    let notified = 0
    reg.subscribe(() => notified++)
    reg.patch({ rovo: { kind: 'http', config: { url: 'https://x' } } })
    expect(reg.get().rovo.enabled).toBe(true)
    expect(notified).toBe(1)
    const onDisk = JSON.parse(fs.readFileSync(mcpServersPath(argusHome), 'utf8'))
    expect(onDisk.rovo).toMatchObject({ kind: 'http', enabled: true, config: { url: 'https://x' } })
  })

  it('patch deep-merges config; null deletes a config key; null deletes an instance', () => {
    reg = new ConnectorRegistry(argusHome)
    reg.patch({ a: { kind: 'stdio', config: { command: 'npx', env: { X: '1' } } } })
    reg.patch({ a: { config: { env: { Y: '2' } } } })
    expect(reg.get().a.config).toEqual({ command: 'npx', env: { X: '1', Y: '2' } })
    reg.patch({ a: { config: { env: null } } })
    expect(reg.get().a.config).toEqual({ command: 'npx' })
    reg.patch({ a: null })
    expect(reg.get()).toEqual({})
    expect(JSON.parse(fs.readFileSync(mcpServersPath(argusHome), 'utf8'))).toEqual({})
  })

  it('round-trips unknown kinds and unknown keys through load → patch → save', () => {
    fs.mkdirSync(path.dirname(mcpServersPath(argusHome)), { recursive: true })
    fs.writeFileSync(
      mcpServersPath(argusHome),
      JSON.stringify({ weird: { kind: 'future', config: { blob: [1] }, futureKey: true } }),
      'utf8'
    )
    reg = new ConnectorRegistry(argusHome)
    reg.patch({ other: { kind: 'stdio', config: {} } })
    const onDisk = JSON.parse(fs.readFileSync(mcpServersPath(argusHome), 'utf8'))
    expect(onDisk.weird).toMatchObject({ kind: 'future', config: { blob: [1] }, futureKey: true })
  })

  it('broken JSON → empty + loadError; file untouched until a save', () => {
    fs.mkdirSync(path.dirname(mcpServersPath(argusHome)), { recursive: true })
    fs.writeFileSync(mcpServersPath(argusHome), '{broken', 'utf8')
    reg = new ConnectorRegistry(argusHome)
    expect(reg.get()).toEqual({})
    expect(reg.loadError()).toBeTruthy()
    expect(fs.readFileSync(mcpServersPath(argusHome), 'utf8')).toBe('{broken')
    reg.patch({ a: { kind: 'stdio', config: {} } })
    expect(reg.loadError()).toBeNull()
  })

  it('setDiscovered caches tools into the entry and persists; unknown id is a no-op', () => {
    reg = new ConnectorRegistry(argusHome)
    reg.patch({ fix: { kind: 'stdio', config: { command: 'x' } } })
    reg.setDiscovered('fix', [{ name: 'get_a', risk: 'low' }])
    expect(reg.get().fix.lastDiscovered?.tools).toEqual([{ name: 'get_a', risk: 'low' }])
    expect(reg.get().fix.lastDiscovered?.at).toBeTruthy()
    reg.setDiscovered('ghost', [{ name: 'x', risk: 'low' }])
    expect(reg.get().ghost).toBeUndefined()
  })

  it('external file change reloads and notifies', async () => {
    reg = new ConnectorRegistry(argusHome)
    reg.patch({ a: { kind: 'stdio', config: {} } }) // ensures file + dir exist
    let notified = false
    reg.subscribe(() => (notified = true))
    fs.writeFileSync(
      mcpServersPath(argusHome),
      JSON.stringify({ a: { kind: 'stdio', config: {}, enabled: false } }),
      'utf8'
    )
    await vi.waitFor(() => expect(notified).toBe(true), { timeout: 3000 })
    expect(reg.get().a.enabled).toBe(false)
  })
})
