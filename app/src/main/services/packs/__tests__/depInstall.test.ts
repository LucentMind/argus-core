import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { applyPlan } from '../depInstall'
import type { StagedPack } from '../depPlanner'
import type { InstallResult } from '../../../../shared/packs'
import type { PacksStateStore } from '../packsState'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-apply-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function pack(id: string, over: Partial<StagedPack> = {}): StagedPack {
  return {
    id,
    version: '1.0.0',
    action: 'install',
    previousVersion: null,
    originLabel: 'x.example',
    isRoot: false,
    bundlePath: `/cache/${id}.zip`,
    source: { kind: 'github', host: 'github.com', owner: 'org', repo: 'packs' },
    ...over
  }
}

describe('applyPlan', () => {
  it('installs every pack in plan order and reports them', async () => {
    const calls: string[] = []
    const r = await applyPlan(
      {
        argusHome: home,
        state: {} as PacksStateStore,
        install: async (source): Promise<InstallResult> => {
          calls.push(path.basename(source))
          return {
            ok: true,
            id: 'x',
            version: '1.0.0',
            previousVersion: null,
            relaunchRequired: true
          }
        }
      },
      [pack('common'), pack('maps', { isRoot: true })]
    )
    expect(calls).toEqual(['common.zip', 'maps.zip'])
    expect(r.installed.map((p) => p.id)).toEqual(['common', 'maps'])
    expect(r.failed).toBeNull()
    expect(r.relaunchRequired).toBe(true)
  })

  it('stops at the first failure and keeps what landed', async () => {
    const calls: string[] = []
    const r = await applyPlan(
      {
        argusHome: home,
        state: {} as PacksStateStore,
        install: async (source): Promise<InstallResult> => {
          const id = path.basename(source, '.zip')
          calls.push(id)
          if (id === 'tiles') return { ok: false, code: 'io', error: 'download corrupt' }
          return { ok: true, id, version: '1.0.0', previousVersion: null, relaunchRequired: true }
        }
      },
      [pack('common'), pack('tiles'), pack('maps', { isRoot: true })]
    )
    expect(calls).toEqual(['common', 'tiles'])
    expect(r.installed.map((p) => p.id)).toEqual(['common'])
    expect(r.failed).toEqual({ id: 'tiles', error: 'download corrupt' })
    expect(r.relaunchRequired).toBe(true)
  })

  it('reports no relaunch when the very first pack fails', async () => {
    const r = await applyPlan(
      {
        argusHome: home,
        state: {} as PacksStateStore,
        install: async (): Promise<InstallResult> => ({ ok: false, code: 'io', error: 'nope' })
      },
      [pack('common')]
    )
    expect(r.installed).toEqual([])
    expect(r.relaunchRequired).toBe(false)
  })

  it('passes every plan member as alsoInstalling so batch upgrades are not self-refused', async () => {
    let seen: ReadonlySet<string> | undefined
    await applyPlan(
      {
        argusHome: home,
        state: {} as PacksStateStore,
        install: async (_source, opts): Promise<InstallResult> => {
          seen = opts.alsoInstalling
          return {
            ok: true,
            id: 'x',
            version: '1.0.0',
            previousVersion: null,
            relaunchRequired: true
          }
        }
      },
      [pack('common'), pack('maps', { isRoot: true })]
    )
    expect([...(seen ?? [])].sort()).toEqual(['common', 'maps'])
  })

  it('pins each pack to the source it was resolved from, stamping installedAt', async () => {
    let pin: unknown
    await applyPlan(
      {
        argusHome: home,
        state: {} as PacksStateStore,
        install: async (_source, opts): Promise<InstallResult> => {
          pin = opts.pinOverride
          return {
            ok: true,
            id: 'x',
            version: '1.0.0',
            previousVersion: null,
            relaunchRequired: true
          }
        }
      },
      [pack('common')]
    )
    expect(pin).toMatchObject({ kind: 'github', owner: 'org', repo: 'packs' })
    expect(typeof (pin as { installedAt: number }).installedAt).toBe('number')
  })

  it('keeps an existing pin rather than adopting a dependent-declared source', async () => {
    const existing = {
      kind: 'feed' as const,
      origin: 'https://trusted.example',
      updateUrl: 'https://trusted.example/f.json',
      installedAt: 1
    }
    let pin: unknown
    await applyPlan(
      {
        argusHome: home,
        state: {} as PacksStateStore,
        existingPins: { common: existing },
        install: async (_s, opts): Promise<InstallResult> => {
          pin = opts.pinOverride
          return {
            ok: true,
            id: 'common',
            version: '1.0.0',
            previousVersion: null,
            relaunchRequired: true
          }
        }
      },
      [pack('common')]
    )
    expect(pin).toEqual(existing)
  })

  /**
   * The root is the pack the user explicitly chose, and choosing it FROM a repository is how a
   * pack installed from a zip or a feed gets re-pointed at that repo (`installFromRepo`'s own
   * comment). The existing-pin precedence above exists to stop a *dependent* redirecting somebody
   * else's bytes; applying it to the root would silently discard the re-point the user asked for.
   */
  it('lets the root pack pin override an existing pin', async () => {
    const existing = {
      kind: 'feed' as const,
      origin: 'https://old.example',
      updateUrl: 'https://old.example/f.json',
      installedAt: 1
    }
    const chosen = {
      kind: 'github' as const,
      host: 'github.com',
      owner: 'org',
      repo: 'packs',
      installedAt: 5,
      manifestPath: 'packs/maps/argus-pack.json'
    }
    let pin: unknown
    await applyPlan(
      {
        argusHome: home,
        state: {} as PacksStateStore,
        existingPins: { maps: existing },
        install: async (_s, opts): Promise<InstallResult> => {
          pin = opts.pinOverride
          return {
            ok: true,
            id: 'maps',
            version: '1.0.0',
            previousVersion: null,
            relaunchRequired: true
          }
        }
      },
      [pack('maps', { isRoot: true, pinOverride: chosen })]
    )
    expect(pin).toEqual(chosen)
  })

  /** A dependency must never carry one — only a main-side root staging call can set it. */
  it('still prefers an existing pin for a non-root pack that carries no override', async () => {
    const existing = {
      kind: 'feed' as const,
      origin: 'https://trusted.example',
      updateUrl: 'https://trusted.example/f.json',
      installedAt: 1
    }
    let pin: unknown
    await applyPlan(
      {
        argusHome: home,
        state: {} as PacksStateStore,
        existingPins: { common: existing },
        install: async (_s, opts): Promise<InstallResult> => {
          pin = opts.pinOverride
          return {
            ok: true,
            id: 'common',
            version: '1.0.0',
            previousVersion: null,
            relaunchRequired: true
          }
        }
      },
      [pack('common', { pinOverride: undefined })]
    )
    expect(pin).toEqual(existing)
  })
})
