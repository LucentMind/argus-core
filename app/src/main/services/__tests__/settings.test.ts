import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsService } from '../settings'
import { settingsPath } from '../paths'
import { defaultSettings } from '../../../shared/settings'

let tmp: string, argusHome: string, appRoot: string, svc: SettingsService

const noEnv = { traceDir: undefined, parseBin: undefined }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-svc-'))
  argusHome = path.join(tmp, 'home')
  appRoot = path.join(tmp, 'app') // nothing auto-resolvable next to it
  fs.mkdirSync(appRoot, { recursive: true })
})

afterEach(() => {
  svc?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('SettingsService', () => {
  it('absent file → defaults, no loadError', () => {
    svc = new SettingsService(argusHome, appRoot, noEnv)
    expect(svc.get()).toEqual(defaultSettings())
    expect(svc.loadError()).toBeNull()
  })

  it('patch persists sparse (only non-default keys on disk) and notifies', () => {
    svc = new SettingsService(argusHome, appRoot, noEnv)
    let notified = 0
    svc.subscribe(() => notified++)
    svc.patch({ agent: { maxSessions: 5 } })
    expect(svc.get().agent.maxSessions).toBe(5)
    expect(notified).toBe(1)
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(argusHome), 'utf8'))
    expect(onDisk).toEqual({ agent: { maxSessions: 5 } })
  })

  it('null in a patch resets a key to default and drops it from disk', () => {
    svc = new SettingsService(argusHome, appRoot, noEnv)
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
    svc = new SettingsService(argusHome, appRoot, noEnv)
    svc.patch({ general: { confirmCaseDelete: false } })
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(argusHome), 'utf8'))
    expect(onDisk.future).toEqual({ x: 1 })
    expect(onDisk.agent).toEqual({ maxSessions: 4 })
    expect(onDisk.general).toEqual({ confirmCaseDelete: false })
  })

  it('invalid JSON → defaults + loadError; broken file untouched until a save', () => {
    fs.mkdirSync(path.dirname(settingsPath(argusHome)), { recursive: true })
    fs.writeFileSync(settingsPath(argusHome), '{broken', 'utf8')
    svc = new SettingsService(argusHome, appRoot, noEnv)
    expect(svc.get()).toEqual(defaultSettings())
    expect(svc.loadError()).toBeTruthy()
    expect(fs.readFileSync(settingsPath(argusHome), 'utf8')).toBe('{broken') // not clobbered
    svc.patch({ agent: { maxSessions: 2 } }) // explicit save replaces it
    expect(svc.loadError()).toBeNull()
  })

  it('schema-invalid content → defaults + loadError', () => {
    fs.mkdirSync(path.dirname(settingsPath(argusHome)), { recursive: true })
    fs.writeFileSync(settingsPath(argusHome), '{"agent":{"maxSessions":"lots"}}', 'utf8')
    svc = new SettingsService(argusHome, appRoot, noEnv)
    expect(svc.get().agent.maxSessions).toBe(3)
    expect(svc.loadError()).toBeTruthy()
  })

  it('resolvedTools: env > settings > default', () => {
    svc = new SettingsService(argusHome, appRoot, { traceDir: 'C:\\envdir', parseBin: undefined })
    svc.patch({ tools: { traceDir: 'C:\\setdir', parseBin: 'C:\\set-parse.exe' } })
    const rt = svc.resolvedTools()
    expect(rt.traceDir).toEqual({ value: 'C:\\envdir', source: 'env' })
    expect(rt.parseBin).toEqual({ value: 'C:\\set-parse.exe', source: 'settings' })
    svc.patch({ tools: { parseBin: null } })
    expect(svc.resolvedTools().parseBin.source).toBe('default') // auto-resolve (null here — bare appRoot)
  })

  it('external file change reloads and notifies', async () => {
    svc = new SettingsService(argusHome, appRoot, noEnv)
    svc.patch({ agent: { maxSessions: 5 } }) // ensures file + dir exist
    let notified = false
    svc.subscribe(() => (notified = true))
    fs.writeFileSync(settingsPath(argusHome), '{"agent":{"maxSessions":7}}', 'utf8')
    await vi.waitFor(() => expect(notified).toBe(true), { timeout: 3000 })
    expect(svc.get().agent.maxSessions).toBe(7)
  })

  it('payload carries dataRoot and env-flag', () => {
    svc = new SettingsService(argusHome, appRoot, noEnv, { argusHomeFromEnv: true })
    const p = svc.payload()
    expect(p.dataRoot).toEqual({ path: argusHome, fromEnv: true })
    expect(p.settings).toEqual(defaultSettings())
    expect(p.loadError).toBeNull()
  })

  it('probeTools: reports version for a working binary and found for a real trace dir', async () => {
    svc = new SettingsService(argusHome, appRoot, noEnv)
    // node itself is a --version-capable stand-in for sample-parse
    const traceDir = path.join(tmp, 'tracebin')
    fs.mkdirSync(traceDir, { recursive: true })
    fs.writeFileSync(
      path.join(traceDir, process.platform === 'win32' ? 'sample-trace.exe' : 'sample-trace'),
      ''
    )
    svc.patch({ tools: { parseBin: process.execPath, traceDir } })
    const r = await svc.probeTools()
    expect(r.parseBin.path).toBe(process.execPath)
    expect(r.parseBin.version).toMatch(/^v?\d/)
    expect(r.traceDir).toEqual({ path: traceDir, found: true })
  })

  it('probeTools: missing binary → version null; empty dir → found false', async () => {
    svc = new SettingsService(argusHome, appRoot, noEnv)
    const emptyDir = path.join(tmp, 'empty')
    fs.mkdirSync(emptyDir, { recursive: true })
    svc.patch({ tools: { parseBin: path.join(tmp, 'nope.exe'), traceDir: emptyDir } })
    const r = await svc.probeTools()
    expect(r.parseBin.version).toBeNull()
    expect(r.traceDir.found).toBe(false)
  })

  it('resolvedTools ignores app-set live env when captured env is empty', () => {
    svc = new SettingsService(argusHome, appRoot, noEnv)
    const bin = path.join(tmp, 'app-exported.exe')
    fs.writeFileSync(bin, '')
    process.env.ARGUS_PARSE_BIN = bin
    try {
      expect(svc.resolvedTools().parseBin).toEqual({ value: null, source: 'default' })
    } finally {
      delete process.env.ARGUS_PARSE_BIN
    }
  })
})
