import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildPlan, type PlannerDeps, type PlanRoot } from '../depPlanner'
import type { ResolvedCandidate } from '../depSources'
import type { PackManifest } from '../manifest'

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

function deps(world: World, installed: Record<string, string> = {}): PlannerDeps {
  return {
    installed,
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
})
