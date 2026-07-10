import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ToolRiskStore } from '../toolRisk'
import { toolRiskPath } from '../paths'

let tmp: string, argusHome: string, store: ToolRiskStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-toolrisk-'))
  argusHome = path.join(tmp, 'home')
})

afterEach(() => {
  store?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ToolRiskStore', () => {
  it('absent file → {}', () => {
    store = new ToolRiskStore(argusHome)
    expect(store.get()).toEqual({})
  })

  it('loads overrides keyed <instanceId>/<toolName>', () => {
    fs.mkdirSync(path.dirname(toolRiskPath(argusHome)), { recursive: true })
    fs.writeFileSync(
      toolRiskPath(argusHome),
      JSON.stringify({ 'rovo/deleteJiraIssue': 'low', 'rovo/getJiraIssue': 'high' }),
      'utf8'
    )
    store = new ToolRiskStore(argusHome)
    expect(store.get()).toEqual({ 'rovo/deleteJiraIssue': 'low', 'rovo/getJiraIssue': 'high' })
  })

  it('invalid content → {} (never throws)', () => {
    fs.mkdirSync(path.dirname(toolRiskPath(argusHome)), { recursive: true })
    fs.writeFileSync(toolRiskPath(argusHome), JSON.stringify({ 'a/b': 'catastrophic' }), 'utf8')
    store = new ToolRiskStore(argusHome)
    expect(store.get()).toEqual({})
  })

  it('watches the file and reloads live', async () => {
    fs.mkdirSync(path.dirname(toolRiskPath(argusHome)), { recursive: true })
    fs.writeFileSync(toolRiskPath(argusHome), '{}', 'utf8')
    store = new ToolRiskStore(argusHome)
    expect(store.get()).toEqual({})
    fs.writeFileSync(toolRiskPath(argusHome), JSON.stringify({ 'x/y': 'high' }), 'utf8')
    await vi.waitFor(() => expect(store.get()).toEqual({ 'x/y': 'high' }), { timeout: 3000 })
  })
})
