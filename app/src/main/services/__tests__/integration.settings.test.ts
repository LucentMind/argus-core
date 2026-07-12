import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { SettingsService } from '../settings'
import { BinariesService } from '../packs/binaries'
import { PackRegistry } from '../packs/registry'
import { packManifestSchema } from '../packs/manifest'
import { AgentService } from '../agent/registry'
import { createSession } from '../agent/sessionStore'
import { AsyncQueue } from '../agent/asyncQueue'
import { createDetection } from '../packs/detection'
import { defaultAgentAccess } from '../../../shared/agentAccess'
import type { CreateQueryFn } from '../agent/session'
import type { LoadedPack } from '../packs/loader'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string
let db: DatabaseSync, svc: SettingsService

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-int-set-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  svc = new SettingsService(argusHome)
})

afterEach(() => {
  svc.close()
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function packWith(binaries: unknown[], dir: string): LoadedPack {
  const manifest = packManifestSchema.parse({
    id: 'testpack',
    displayName: 'T',
    version: '1',
    argusApi: '^1',
    binaries
  })
  return {
    id: 'testpack',
    dir,
    manifest,
    personaText: null,
    skillsDir: null,
    referencesDir: null,
    uiDir: null
  }
}

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
      detection: createDetection(),
      skillsRoots: [],
      onEvent: () => {},
      agentAccess: () => defaultAgentAccess(),
      createQuery,
      agentSettings: () => svc.get().agent
    })
    createCase(db, argusHome, { slug: 'INT-1', title: 't' })
    const s1 = createSession(db, 'INT-1')
    await agents.send('INT-1', s1.id, 'hello')
    expect((captured[0].systemPrompt as { append: string }).append).toContain('Focus on ADAS.')
    expect(captured[0].model).toBe('claude-sonnet-5')
    await agents.stopAll()
  })

  it('a settings patch of tools.parseBin flows through settingsTools into a BinariesService recompute', () => {
    const bin = path.join(tmp, 'sample-parse.exe')
    fs.writeFileSync(bin, '')
    const binaries = new BinariesService({
      registry: new PackRegistry([
        packWith(
          [
            {
              id: 'sample-parse',
              kind: 'exe',
              displayName: 'sample-parse binary',
              names: ['sample-parse'],
              envVar: 'ARGUS_PARSE_BIN',
              settingsKey: 'parseBin'
            }
          ],
          tmp
        )
      ]),
      settingsTools: () => svc.get().tools,
      capturedEnv: { ARGUS_PARSE_BIN: undefined }
    })
    expect(binaries.get('sample-parse')).toMatchObject({ value: null, source: null })

    svc.patch({ tools: { parseBin: bin } })
    binaries.recompute()

    expect(binaries.get('sample-parse')).toMatchObject({ value: bin, source: 'settings' })
    expect(svc.payload().settings.tools.parseBin).toBe(bin) // store-reload semantics: patch is reflected in get()/payload()
  })
})
