import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { SettingsService } from '../settings'
import { resolveArgusParse } from '../parsers'
import { AgentService } from '../agent/registry'
import { AsyncQueue } from '../agent/asyncQueue'
import type { CreateQueryFn } from '../agent/session'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string, appRoot: string
let db: DatabaseSync, svc: SettingsService

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-int-set-'))
  argusHome = path.join(tmp, 'home')
  appRoot = path.join(tmp, 'app')
  fs.mkdirSync(appRoot, { recursive: true })
  db = openDb(path.join(argusHome, 'argus.db'))
  svc = new SettingsService(argusHome, appRoot, { traceDir: undefined, parseBin: undefined })
})

afterEach(() => {
  svc.close()
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('settings → consumers (wave-spec §8 integration)', () => {
  it('patched personaAppend + model reach the next CaseSession options', async () => {
    svc.patch({
      agent: {
        personaAppend: 'Focus on ADAS.',
        providerInstances: {
          'claude-default': { config: { model: 'claude-sonnet-5' } }
        }
      }
    })
    const captured: Record<string, unknown>[] = []
    const createQuery: CreateQueryFn = (args) => {
      captured.push(args.options as Record<string, unknown>)
      const q = new AsyncQueue<unknown>()
      return Object.assign(
        { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
        { interrupt: vi.fn(async () => q.end()) }
      )
    }
    const agents = new AgentService({
      db,
      argusHome,
      skillsRoots: [],
      onEvent: () => {},
      createQuery,
      agentSettings: () => svc.get().agent
    })
    createCase(db, argusHome, { slug: 'INT-1', title: 't' })
    await agents.send('INT-1', 'hello')
    expect((captured[0].systemPrompt as { append: string }).append).toContain('Focus on ADAS.')
    expect(captured[0].model).toBe('claude-sonnet-5')
    await agents.stopAll()
  })

  it('patched tools.parseBin resolves when the env var is unset', () => {
    const bin = path.join(tmp, 'sample-parse.exe')
    fs.writeFileSync(bin, '')
    svc.patch({ tools: { parseBin: bin } })
    expect(resolveArgusParse(appRoot, svc.get().tools.parseBin)).toBe(bin)
    expect(svc.resolvedTools().parseBin).toEqual({ value: bin, source: 'settings' })
  })
})
