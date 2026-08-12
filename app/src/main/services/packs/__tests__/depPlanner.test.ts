import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildPlan, stagePlan, toPlannedRows, type PlannerDeps, type PlanRoot } from '../depPlanner'
import type { ResolvedCandidate } from '../depSources'
import type { DeclaredSource } from '../dependencies'
import type { PackManifest } from '../manifest'
import type { PackSource } from '../packsState'

let home: string
let cache: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-plan-'))
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-plancache-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(cache, { recursive: true, force: true })
})

/** A world of publishable packs: id -> version -> its own declared dependencies. */
type World = Record<string, Record<string, PackManifest['dependencies']>>

function deps(
  world: World,
  installed: Record<string, string> = {},
  pins: Record<string, PackSource | undefined> = {}
): PlannerDeps {
  return {
    installed,
    pins,
    argusHome: home,
    cacheDir: cache,
    resolver: {
      async resolve(id, range, source): Promise<ResolvedCandidate | null> {
        const versions = Object.keys(world[id] ?? {})
        // Newest first; the fake keeps range handling trivial by exact-prefix matching.
        const semverModule = await import('semver')
        const hit = versions
          .filter((v) => semverModule.default.satisfies(v, range))
          .sort((a, b) => semverModule.default.rcompare(a, b))[0]
        if (!hit) return null
        return {
          id,
          version: hit,
          download: {
            kind: 'url',
            url: `https://x.example/${id}-${hit}.zip`,
            sha256: 'a'.repeat(64)
          },
          source,
          originLabel: 'x.example'
        }
      }
    },
    async download(candidate, destPath) {
      fs.writeFileSync(destPath, `${candidate.id}@${candidate.version}`)
    },
    async inspect(bundlePath) {
      const [id, version] = fs.readFileSync(bundlePath, 'utf8').split('@')
      // Returns exactly PlannerDeps['inspect']'s shape — the planner asks for the narrow
      // {id, version, rawDependencies}, not a whole InspectResult, so no cast is needed.
      return { id, version, rawDependencies: world[id][version] }
    }
  }
}

function root(id: string, version: string, dependencies: PackManifest['dependencies']): PlanRoot {
  return { id, version, bundlePath: path.join(cache, 'root.zip'), source: null, dependencies }
}

/** Writes a pack dir under <home>/packs so `dependentRangesOn` can read it. */
function writeInstalledPack(
  argusHome: string,
  id: string,
  version: string,
  dependencies: Record<string, unknown>
): void {
  const dir = path.join(argusHome, 'packs', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'argus-pack.json'),
    JSON.stringify({ id, displayName: id, version, argusApi: '^1.1', dependencies })
  )
}

describe('buildPlan', () => {
  it('plans a single missing dependency before its dependent', async () => {
    const world: World = { common: { '1.4.0': {} } }
    const r = await buildPlan(
      deps(world),
      root('maps', '2.0.0', {
        common: { range: '^1.0.0', updateRepo: 'org/packs' }
      })
    )
    expect(r.ok).toBe(true)
    expect(r.ok && r.packs.map((p) => `${p.id}@${p.version}`)).toEqual([
      'common@1.4.0',
      'maps@2.0.0'
    ])
    expect(r.ok && r.packs.map((p) => p.isRoot)).toEqual([false, true])
  })

  it('omits a dependency already installed inside the range', async () => {
    const world: World = { common: { '1.4.0': {} } }
    const r = await buildPlan(
      deps(world, { common: '1.2.0' }),
      root('maps', '2.0.0', { common: { range: '^1.0.0', updateRepo: 'org/packs' } })
    )
    expect(r.ok && r.packs.map((p) => p.id)).toEqual(['maps'])
  })

  it('marks an out-of-range installed dependency as an upgrade', async () => {
    const world: World = { common: { '2.1.0': {} } }
    const r = await buildPlan(
      deps(world, { common: '1.2.0' }),
      root('maps', '2.0.0', { common: { range: '^2.0.0', updateRepo: 'org/packs' } })
    )
    expect(r.ok && r.packs[0]).toMatchObject({
      id: 'common',
      version: '2.1.0',
      action: 'upgrade',
      previousVersion: '1.2.0'
    })
  })

  it('recurses into a transitive dependency', async () => {
    const world: World = {
      tiles: { '0.4.0': {} },
      common: { '1.4.0': { tiles: { range: '^0.4', updateRepo: 'org/packs' } } }
    }
    const r = await buildPlan(
      deps(world),
      root('maps', '2.0.0', {
        common: { range: '^1.0.0', updateRepo: 'org/packs' }
      })
    )
    expect(r.ok && r.packs.map((p) => p.id)).toEqual(['tiles', 'common', 'maps'])
  })

  it('plans a diamond once, not twice', async () => {
    const world: World = {
      base: { '1.0.0': {} },
      a: { '1.0.0': { base: { range: '^1', updateRepo: 'org/packs' } } },
      b: { '1.0.0': { base: { range: '^1', updateRepo: 'org/packs' } } }
    }
    const r = await buildPlan(
      deps(world),
      root('top', '1.0.0', {
        a: { range: '^1', updateRepo: 'org/packs' },
        b: { range: '^1', updateRepo: 'org/packs' }
      })
    )
    expect(r.ok && r.packs.filter((p) => p.id === 'base')).toHaveLength(1)
    expect(r.ok && r.packs.map((p) => p.id).indexOf('base')).toBe(0)
  })

  it('refuses a dependency that declares no source', async () => {
    const r = await buildPlan(deps({}), root('maps', '2.0.0', { common: '^1.0.0' }))
    expect(r).toMatchObject({ ok: false, code: 'unresolvable' })
    expect(r.ok ? '' : r.error).toContain('common')
  })

  it('refuses when the source publishes nothing satisfying the range', async () => {
    const world: World = { common: { '0.9.0': {} } }
    const r = await buildPlan(
      deps(world),
      root('maps', '2.0.0', {
        common: { range: '^1.0.0', updateRepo: 'org/packs' }
      })
    )
    expect(r).toMatchObject({ ok: false, code: 'unresolvable' })
  })

  it('refuses a cycle rather than looping forever', async () => {
    const world: World = {
      common: { '1.0.0': { maps: { range: '^2', updateRepo: 'org/packs' } } },
      maps: { '2.0.0': { common: { range: '^1', updateRepo: 'org/packs' } } }
    }
    const r = await buildPlan(
      deps(world),
      root('maps', '2.0.0', {
        common: { range: '^1', updateRepo: 'org/packs' }
      })
    )
    expect(r).toMatchObject({ ok: false, code: 'cycle' })
  })

  it('writes nothing into the packs dir', async () => {
    const world: World = { common: { '1.4.0': {} } }
    await buildPlan(
      deps(world),
      root('maps', '2.0.0', {
        common: { range: '^1.0.0', updateRepo: 'org/packs' }
      })
    )
    expect(fs.existsSync(path.join(home, 'packs'))).toBe(false)
  })

  it('omits staging fields from the IPC-facing plan', async () => {
    const world: World = { common: { '1.4.0': {} } }
    const staged = await stagePlan(
      deps(world),
      root('maps', '2.0.0', {
        common: { range: '^1.0.0', updateRepo: 'org/packs' }
      })
    )
    expect(staged.ok).toBe(true)
    const rows = toPlannedRows(staged.ok ? staged.packs : [])
    expect(rows.length).toBeGreaterThan(0)
    for (const p of rows) {
      expect(Object.hasOwn(p, 'bundlePath')).toBe(false)
      expect(Object.hasOwn(p, 'source')).toBe(false)
    }
  })
})

describe('buildPlan refusals', () => {
  it('refuses two requesters whose ranges cannot both be met', async () => {
    const world: World = {
      base: { '1.0.0': {}, '2.0.0': {} },
      a: { '1.0.0': { base: { range: '^1', updateRepo: 'org/packs' } } },
      b: { '1.0.0': { base: { range: '^2', updateRepo: 'org/packs' } } }
    }
    const r = await buildPlan(
      deps(world),
      root('top', '1.0.0', {
        a: { range: '^1', updateRepo: 'org/packs' },
        b: { range: '^1', updateRepo: 'org/packs' }
      })
    )
    expect(r).toMatchObject({ ok: false, code: 'conflict' })
    const msg = r.ok ? '' : r.error
    expect(msg).toContain('base')
    expect(msg).toContain('^1')
    expect(msg).toContain('^2')
  })

  it('refuses an upgrade that would strand an installed pack outside the plan', async () => {
    // 'legacy' is installed, requires common ^1, and is NOT part of this plan.
    writeInstalledPack(home, 'legacy', '1.0.0', { common: '^1.0.0' })
    writeInstalledPack(home, 'common', '1.2.0', {})
    const world: World = { common: { '2.0.0': {} } }
    const r = await buildPlan(
      deps(world, { common: '1.2.0', legacy: '1.0.0' }),
      root('maps', '2.0.0', { common: { range: '^2.0.0', updateRepo: 'org/packs' } })
    )
    expect(r).toMatchObject({ ok: false, code: 'breaks-dependent' })
    expect(r.ok ? '' : r.error).toContain('legacy')
  })

  it('allows a coordinated upgrade of a dependency and its dependent', async () => {
    // 'maps' is installed at 1.0.0 requiring common ^1, and IS the root being upgraded to 2.0.0,
    // whose manifest requires common ^2. The on-disk guard alone would refuse this.
    writeInstalledPack(home, 'maps', '1.0.0', { common: '^1.0.0' })
    writeInstalledPack(home, 'common', '1.2.0', {})
    const world: World = { common: { '2.0.0': {} } }
    const r = await buildPlan(
      deps(world, { common: '1.2.0', maps: '1.0.0' }),
      root('maps', '2.0.0', { common: { range: '^2.0.0', updateRepo: 'org/packs' } })
    )
    expect(r.ok).toBe(true)
    expect(r.ok && r.packs.map((p) => p.id)).toEqual(['common', 'maps'])
  })
})

describe('buildPlan dependency-confusion defence', () => {
  const trustedFeed: PackSource = {
    kind: 'feed',
    origin: 'https://trusted.example',
    updateUrl: 'https://trusted.example/f.json',
    installedAt: 1
  }
  const trustedDeclared: DeclaredSource = {
    kind: 'feed',
    updateUrl: 'https://trusted.example/f.json',
    origin: 'https://trusted.example'
  }

  function spyResolverDeps(
    resolve: (
      id: string,
      range: string,
      source: DeclaredSource
    ) => Promise<ResolvedCandidate | null>,
    pins: Record<string, PackSource | undefined>,
    installed: Record<string, string>
  ): PlannerDeps {
    return {
      installed,
      pins,
      argusHome: home,
      cacheDir: cache,
      resolver: { resolve },
      async download(candidate, destPath) {
        fs.writeFileSync(destPath, `${candidate.id}@${candidate.version}`)
      },
      async inspect(bundlePath) {
        const [id, version] = fs.readFileSync(bundlePath, 'utf8').split('@')
        return { id, version, rawDependencies: {} }
      }
    }
  }

  it("resolves an already-installed pinned dependency from its own pin, not the dependent's declared source", async () => {
    const calls: Array<{ id: string; range: string; source: DeclaredSource }> = []
    const d = spyResolverDeps(
      async (id, range, source) => {
        calls.push({ id, range, source })
        return {
          id,
          version: '2.0.0',
          download: {
            kind: 'url',
            url: 'https://trusted.example/common-2.0.0.zip',
            sha256: 'a'.repeat(64)
          },
          source,
          originLabel: 'trusted.example'
        }
      },
      { common: trustedFeed },
      { common: '1.2.0' }
    )
    const r = await buildPlan(
      d,
      // A hostile dependent declares an upgrade sourced from an attacker-controlled repo.
      root('maps', '2.0.0', { common: { range: '^2', updateRepo: 'attacker/evil' } })
    )
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].source).toEqual(trustedDeclared)
  })

  it("refuses rather than falling back to the dependent's declared source when the pin has nothing in range", async () => {
    const calls: DeclaredSource[] = []
    const d = spyResolverDeps(
      async (_id, _range, source) => {
        calls.push(source)
        return null // trusted.example publishes nothing satisfying ^2
      },
      { common: trustedFeed },
      { common: '1.2.0' }
    )
    const r = await buildPlan(
      d,
      root('maps', '2.0.0', { common: { range: '^2', updateRepo: 'attacker/evil' } })
    )
    expect(r).toMatchObject({ ok: false, code: 'unresolvable' })
    expect(calls).toEqual([trustedDeclared])
    const msg = r.ok ? '' : r.error
    expect(msg).toContain('common')
    expect(msg).toContain('trusted.example')
    expect(msg).toContain('^2')
  })

  it('resolves a not-installed dependency from the declared source (ordinary path, unchanged)', async () => {
    const calls: DeclaredSource[] = []
    const d = spyResolverDeps(
      async (id, _range, source) => {
        calls.push(source)
        return {
          id,
          version: '1.4.0',
          download: { kind: 'url', url: 'https://x.example/common.zip', sha256: 'a'.repeat(64) },
          source,
          originLabel: 'x.example'
        }
      },
      {},
      {}
    )
    const r = await buildPlan(
      d,
      root('maps', '2.0.0', { common: { range: '^1', updateRepo: 'org/packs' } })
    )
    expect(r.ok).toBe(true)
    expect(calls).toEqual([{ kind: 'github', host: 'github.com', owner: 'org', repo: 'packs' }])
  })
})
