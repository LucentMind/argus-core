import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsService } from '../settings'
import { settingsPath } from '../paths'
import { defaultSettings } from '../../../shared/settings'
import type { ResolvedToolRow } from '../../../shared/settings'

let tmp: string, argusHome: string, svc: SettingsService

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-svc-'))
  argusHome = path.join(tmp, 'home')
})

afterEach(() => {
  svc?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('SettingsService', () => {
  it('absent file → defaults, no loadError', () => {
    svc = new SettingsService(argusHome)
    expect(svc.get()).toEqual(defaultSettings())
    expect(svc.loadError()).toBeNull()
  })

  it('patch persists sparse (only non-default keys on disk) and notifies', () => {
    svc = new SettingsService(argusHome)
    let notified = 0
    svc.subscribe(() => notified++)
    svc.patch({ agent: { maxSessions: 5 } })
    expect(svc.get().agent.maxSessions).toBe(5)
    expect(notified).toBe(1)
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(argusHome), 'utf8'))
    expect(onDisk).toEqual({ agent: { maxSessions: 5 } })
  })

  it('null in a patch resets a key to default and drops it from disk', () => {
    svc = new SettingsService(argusHome)
    svc.patch({ agent: { personaAppend: 'be brief' } })
    svc.patch({ agent: { personaAppend: null } })
    expect(svc.get().agent.personaAppend).toBe('')
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(argusHome), 'utf8'))
    expect(onDisk).toEqual({})
  })

  it('preserves unknown keys across load → patch → save', () => {
    fs.mkdirSync(path.dirname(settingsPath(argusHome)), { recursive: true })
    fs.writeFileSync(
      settingsPath(argusHome),
      '{"future":{"x":1},"agent":{"maxSessions":4}}',
      'utf8'
    )
    svc = new SettingsService(argusHome)
    svc.patch({ general: { confirmCaseDelete: false } })
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(argusHome), 'utf8'))
    expect(onDisk.future).toEqual({ x: 1 })
    expect(onDisk.agent).toEqual({ maxSessions: 4 })
    expect(onDisk.general).toEqual({ confirmCaseDelete: false })
  })

  it('invalid JSON → defaults + loadError; broken file untouched until a save', () => {
    fs.mkdirSync(path.dirname(settingsPath(argusHome)), { recursive: true })
    fs.writeFileSync(settingsPath(argusHome), '{broken', 'utf8')
    svc = new SettingsService(argusHome)
    expect(svc.get()).toEqual(defaultSettings())
    expect(svc.loadError()).toBeTruthy()
    expect(fs.readFileSync(settingsPath(argusHome), 'utf8')).toBe('{broken') // not clobbered
    svc.patch({ agent: { maxSessions: 2 } }) // explicit save replaces it
    expect(svc.loadError()).toBeNull()
  })

  it('schema-invalid content → defaults + loadError', () => {
    fs.mkdirSync(path.dirname(settingsPath(argusHome)), { recursive: true })
    fs.writeFileSync(settingsPath(argusHome), '{"agent":{"maxSessions":"lots"}}', 'utf8')
    svc = new SettingsService(argusHome)
    expect(svc.get().agent.maxSessions).toBe(3)
    expect(svc.loadError()).toBeTruthy()
  })

  it('external file change reloads and notifies', async () => {
    svc = new SettingsService(argusHome)
    svc.patch({ agent: { maxSessions: 5 } }) // ensures file + dir exist
    let notified = false
    svc.subscribe(() => (notified = true))
    fs.writeFileSync(settingsPath(argusHome), '{"agent":{"maxSessions":7}}', 'utf8')
    await vi.waitFor(() => expect(notified).toBe(true), { timeout: 3000 })
    expect(svc.get().agent.maxSessions).toBe(7)
  })

  it('payload carries dataRoot and env-flag', () => {
    svc = new SettingsService(argusHome, { argusHomeFromEnv: true })
    const p = svc.payload()
    expect(p.dataRoot).toEqual({ path: argusHome, fromEnv: true })
    expect(p.settings).toEqual(defaultSettings())
    expect(p.loadError).toBeNull()
  })

  it('payload.resolvedTools defaults to [] when no callback is injected', () => {
    svc = new SettingsService(argusHome)
    expect(svc.payload().resolvedTools).toEqual([])
  })

  it('payload.resolvedTools embeds the injected rows verbatim', () => {
    const rows: ResolvedToolRow[] = [
      {
        id: 'fake-parse',
        displayName: 'Fake parse',
        description: 'desc',
        kind: 'exe',
        envVar: 'FAKE_BIN',
        settingsKey: 'parseBin',
        settingsValue: '',
        value: null,
        source: 'default'
      }
    ]
    svc = new SettingsService(argusHome, { resolvedTools: () => rows })
    expect(svc.payload().resolvedTools).toEqual(rows)
  })

  it('instance edits survive a reload (sparse file re-parses)', () => {
    svc = new SettingsService(argusHome)
    svc.patch({
      agent: { providerInstances: { 'claude-default': { config: { model: 'claude-sonnet-5' } } } }
    })
    const model = (svc.get().agent.providerInstances['claude-default'].config as { model?: string })
      .model
    expect(model).toBe('claude-sonnet-5')
    svc.close()
    svc = new SettingsService(argusHome) // simulated restart
    expect(svc.loadError()).toBeNull()
    expect(
      (svc.get().agent.providerInstances['claude-default'].config as { model?: string }).model
    ).toBe('claude-sonnet-5')
  })
})
