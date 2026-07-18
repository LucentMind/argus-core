import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  graphsRoot,
  repoIdFor,
  scopeKeyFor,
  graphCacheDir,
  readMeta,
  writeMeta,
  parseExtractCounts,
  parseProgressLine,
  CodeGraphService,
  type GraphMeta
} from '../codeGraph'

const execFileAsync = promisify(execFile)

describe('codeGraph helpers', () => {
  it('graphsRoot is <argusHome>/graphs', () => {
    expect(graphsRoot('C:\\home')).toBe(path.join('C:\\home', 'graphs'))
  })

  it('repoIdFor slugs the remote owner/name when a remote exists', () => {
    expect(repoIdFor('C:\\code\\widget-lib', 'https://github.com/acme/widget-lib.git')).toBe(
      'acme-widget-lib'
    )
    expect(repoIdFor('/x/y', 'git@github.com:Org/My.Repo.git')).toBe('org-my-repo')
  })

  it('repoIdFor without remote uses basename + stable path hash', () => {
    const a = repoIdFor('C:\\code\\navigator', null)
    const b = repoIdFor('C:\\code\\navigator', null)
    const c = repoIdFor('C:\\other\\navigator', null)
    expect(a).toBe(b)
    expect(a).toMatch(/^navigator-[0-9a-f]{8}$/)
    expect(a).not.toBe(c)
  })

  it('scopeKeyFor maps null to _root and slugs subpaths', () => {
    expect(scopeKeyFor(null)).toBe('_root')
    expect(scopeKeyFor('src/routing')).toBe('src-routing')
    expect(scopeKeyFor('src\\routing\\')).toBe('src-routing')
  })

  it('scopeKeyFor rejects escaping or absolute scopes', () => {
    expect(() => scopeKeyFor('../secrets')).toThrow()
    expect(() => scopeKeyFor('C:\\windows')).toThrow()
    expect(() => scopeKeyFor('/etc')).toThrow()
    expect(() => scopeKeyFor('  ')).toThrow()
  })

  it('graphCacheDir nests repoId/scopeKey under graphsRoot', () => {
    expect(graphCacheDir('C:\\home', 'acme-widget-lib', '_root')).toBe(
      path.join('C:\\home', 'graphs', 'acme-widget-lib', '_root')
    )
  })

  it('scopeKeyFor rejects scopes that slug to nothing', () => {
    expect(() => scopeKeyFor('.')).toThrow()
    expect(() => scopeKeyFor('___')).toThrow()
    expect(() => scopeKeyFor('!!!')).toThrow()
  })

  it('repoIdFor falls back to path hash when the remote tail slugs to nothing', () => {
    const id = repoIdFor('C:\\code\\navigator', 'https://host/---/___.git')
    expect(id).toMatch(/^navigator-[0-9a-f]{8}$/)
  })

  it('meta round-trips through the cache dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-graph-'))
    expect(readMeta(dir)).toBeNull()
    const meta: GraphMeta = {
      commit: 'abc123',
      branch: 'main',
      scope: null,
      builtAt: new Date().toISOString(),
      graphifyVersion: 'graphify 0.9.12',
      nodeCount: 9171,
      edgeCount: 31372,
      status: 'ok'
    }
    writeMeta(dir, meta)
    expect(readMeta(dir)).toEqual(meta)
  })

  it('readMeta returns null on corrupt json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-graph-'))
    fs.writeFileSync(path.join(dir, 'meta.json'), '{nope')
    expect(readMeta(dir)).toBeNull()
  })

  it('parseExtractCounts reads the graphify summary line', () => {
    const out =
      '[graphify extract] wrote C:\\x\\graphify-out\\graph.json: 9171 nodes, 31372 edges, 304 communities'
    expect(parseExtractCounts(out)).toEqual({ nodes: 9171, edges: 31372 })
    expect(parseExtractCounts('no summary here')).toEqual({ nodes: null, edges: null })
  })

  it('parseProgressLine extracts a percentage and strips the bracketed prefix', () => {
    expect(
      parseProgressLine('  AST extraction: 4900/5043 uncached files (97%) [16 workers]')
    ).toEqual({
      message: 'AST extraction: 4900/5043 uncached files (97%) [16 workers]',
      percent: 97
    })
    expect(parseProgressLine('[graphify extract] scanning C:\\repo')).toEqual({
      message: 'scanning C:\\repo',
      percent: null
    })
    expect(parseProgressLine('   ')).toBeNull()
  })
})

/** Real git fixture repo: 2 commits so `behind` is measurable. */
async function makeRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-repo-'))
  const g = (...a: string[]): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync('git', a, { cwd: dir })
  await g('init')
  await g('config', 'user.email', 't@t')
  await g('config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
  await g('add', '.')
  await g('commit', '-m', 'one')
  fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2\n')
  await g('add', '.')
  await g('commit', '-m', 'two')
  return dir
}

describe('CodeGraphService', () => {
  it('build throws on a nonexistent repo path', async () => {
    const svc = new CodeGraphService({
      argusHome: fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-')),
      pathOf: () => 'g',
      recompute: vi.fn(),
      broadcast: vi.fn()
    })
    expect(() => svc.build(path.join(os.tmpdir(), 'does-not-exist-xyz'), null)).toThrow(/not found/)
  })

  it('build with unresolved binary returns missing:true and broadcasts nothing', async () => {
    const broadcast = vi.fn()
    const svc = new CodeGraphService({
      argusHome: fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-')),
      pathOf: () => null,
      recompute: vi.fn(),
      broadcast
    })
    expect(svc.build('C:\\nope', null)).toEqual({ started: false, missing: true })
    expect(broadcast).not.toHaveBeenCalled()
  })

  // These tests spawn real git processes (fixture repo + 2-3 spawns per status() poll).
  // Under full-suite worker contention a spawn can take hundreds of ms, so the default
  // 1s vi.waitFor / 5s test budgets flake — every poll below gets an explicit bound.
  const POLL = { timeout: 15_000 }

  it(
    'build runs graphify extract into the cache dir, writes ok meta, broadcasts lifecycle',
    { timeout: 30_000 },
    async () => {
      const repo = await makeRepo()
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
      const broadcast = vi.fn()
      const exec = vi.fn(async (_bin: string, args: string[]) => {
        if (args[0] !== 'extract') return { stdout: 'graphify 0.9.12', stderr: '' } // --version probe
        // graphify writes graphify-out/ under --out; simulate that
        const outIdx = args.indexOf('--out')
        const outDir = path.join(args[outIdx + 1], 'graphify-out')
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, 'graph.json'), '{}')
        return {
          stdout: `[graphify extract] wrote ${path.join(outDir, 'graph.json')}: 42 nodes, 99 edges, 3 communities`,
          stderr: ''
        }
      })
      const svc = new CodeGraphService({
        argusHome: home,
        pathOf: () => 'C:\\tools\\graphify.exe',
        recompute: vi.fn(),
        broadcast,
        exec
      })
      expect(svc.build(repo, null)).toEqual({ started: true })
      // build is fire-and-forget — poll status until it settles
      await vi.waitFor(async () => {
        const rows = await svc.status(repo)
        expect(rows[0]?.status).toBe('ok')
      }, POLL)
      const [row] = await svc.status(repo)
      expect(row.nodeCount).toBe(42)
      expect(row.behind).toBe(0)
      expect(exec).toHaveBeenCalledWith(
        'C:\\tools\\graphify.exe',
        expect.arrayContaining(['extract', repo, '--code-only', '--out']),
        expect.objectContaining({ timeout: 30 * 60 * 1000 }),
        expect.any(Function)
      )
      expect(broadcast).toHaveBeenCalledWith('graph:building', {
        repoPath: repo,
        scope: null,
        active: true
      })
      expect(broadcast).toHaveBeenCalledWith('graph:building', {
        repoPath: repo,
        scope: null,
        active: false
      })
      expect(broadcast).toHaveBeenCalledWith('graph:changed', { repoPath: repo })
    }
  )

  it(
    'build streams progress lines from the extract call as graph:progress broadcasts',
    { timeout: 30_000 },
    async () => {
      const repo = await makeRepo()
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
      const broadcast = vi.fn()
      const exec = vi.fn(
        async (
          _bin: string,
          args: string[],
          _opts: unknown,
          onOutput?: (chunk: string) => void
        ) => {
          if (args[0] !== 'extract') return { stdout: 'graphify 0.9.12', stderr: '' }
          const outDir = path.join(args[args.indexOf('--out') + 1], 'graphify-out')
          fs.mkdirSync(outDir, { recursive: true })
          onOutput?.('[graphify extract] scanning C:\\repo\n  AST extraction: 50/100 files (50%)\n')
          return {
            stdout: 'wrote graph.json: 1 nodes, 0 edges',
            stderr: ''
          }
        }
      )
      const svc = new CodeGraphService({
        argusHome: home,
        pathOf: () => 'g',
        recompute: vi.fn(),
        broadcast,
        exec
      })
      svc.build(repo, null)
      await vi.waitFor(async () => {
        const rows = await svc.status(repo)
        expect(rows[0]?.status).toBe('ok')
      }, POLL)
      expect(broadcast).toHaveBeenCalledWith('graph:progress', {
        repoPath: repo,
        scope: null,
        message: 'scanning C:\\repo',
        percent: null
      })
      expect(broadcast).toHaveBeenCalledWith('graph:progress', {
        repoPath: repo,
        scope: null,
        message: 'AST extraction: 50/100 files (50%)',
        percent: 50
      })
    }
  )

  it(
    'scoped build extracts the subdir and shows a distinct status row',
    { timeout: 30_000 },
    async () => {
      const repo = await makeRepo()
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
      const exec = vi.fn(async (_b: string, args: string[]) => {
        if (args[0] !== 'extract') return { stdout: 'graphify 0.9.12', stderr: '' }
        const outDir = path.join(args[args.indexOf('--out') + 1], 'graphify-out')
        fs.mkdirSync(outDir, { recursive: true })
        return { stdout: 'wrote graph.json: 1 nodes, 0 edges', stderr: '' }
      })
      const svc = new CodeGraphService({
        argusHome: home,
        pathOf: () => 'g',
        recompute: vi.fn(),
        broadcast: vi.fn(),
        exec
      })
      svc.build(repo, 'src')
      await vi.waitFor(async () => {
        const rows = await svc.status(repo)
        expect(rows.find((r) => r.scopeKey === 'src')?.status).toBe('ok')
      }, POLL)
      // exec receives a --version probe AND the extract; assert on the extract call
      const extract = exec.mock.calls.find((c) => c[1][0] === 'extract')
      expect(extract![1]).toContain(path.join(repo, 'src'))
    }
  )

  it(
    'failed build writes failed meta with the error and build.log survives',
    { timeout: 30_000 },
    async () => {
      const repo = await makeRepo()
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
      const exec = vi.fn(async () => {
        throw new Error('boom: tree-sitter exploded')
      })
      const svc = new CodeGraphService({
        argusHome: home,
        pathOf: () => 'g',
        recompute: vi.fn(),
        broadcast: vi.fn(),
        exec
      })
      svc.build(repo, null)
      await vi.waitFor(async () => {
        const rows = await svc.status(repo)
        expect(rows[0]?.status).toBe('failed')
      }, POLL)
      const [row] = await svc.status(repo)
      expect(row.error).toContain('boom')
    }
  )

  it(
    'concurrent builds of the same repo+scope coalesce to one extraction',
    { timeout: 30_000 },
    async () => {
      const repo = await makeRepo()
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
      let resolveExec!: () => void
      const gate = new Promise<void>((r) => {
        resolveExec = r
      })
      const exec = vi.fn(async (_b: string, args: string[]) => {
        if (args[0] !== 'extract') return { stdout: 'graphify 0.9.12', stderr: '' }
        await gate
        const outDir = path.join(args[args.indexOf('--out') + 1], 'graphify-out')
        fs.mkdirSync(outDir, { recursive: true })
        return { stdout: '', stderr: '' }
      })
      const svc = new CodeGraphService({
        argusHome: home,
        pathOf: () => 'g',
        recompute: vi.fn(),
        broadcast: vi.fn(),
        exec
      })
      expect(svc.build(repo, null)).toEqual({ started: true })
      expect(svc.build(repo, null)).toEqual({ started: true }) // second call joins, doesn't respawn
      const [row] = await svc.status(repo)
      expect(row.status).toBe('building')
      resolveExec()
      await vi.waitFor(
        async () => expect((await svc.status(repo))[0].status).not.toBe('building'),
        POLL
      )
      // one --version probe + one extract — the point is a single extract despite two build() calls
      expect(exec.mock.calls.filter((c) => c[1][0] === 'extract')).toHaveLength(1)
    }
  )

  it(
    'status reports behind-count when the repo advanced past the built commit',
    { timeout: 30_000 },
    async () => {
      const repo = await makeRepo()
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
      const g = (...a: string[]): Promise<{ stdout: string; stderr: string }> =>
        execFileAsync('git', a, { cwd: repo })
      const firstCommit = (await g('rev-parse', 'HEAD~1')).stdout.trim()
      // hand-write a meta as if built at the first commit
      const dir = graphCacheDir(home, repoIdFor(repo, null), '_root')
      writeMeta(dir, {
        commit: firstCommit,
        branch: 'main',
        scope: null,
        builtAt: new Date().toISOString(),
        graphifyVersion: null,
        nodeCount: 1,
        edgeCount: 1,
        status: 'ok'
      })
      const svc = new CodeGraphService({
        argusHome: home,
        pathOf: () => 'g',
        recompute: vi.fn(),
        broadcast: vi.fn()
      })
      const [row] = await svc.status(repo)
      expect(row.behind).toBe(1)
    }
  )

  it('installTool prefers uv, falls back to pipx, reports absence of both', async () => {
    const calls: string[][] = []
    const mk = (available: string[]): CodeGraphService =>
      new CodeGraphService({
        argusHome: fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-')),
        pathOf: () => null,
        recompute: vi.fn(),
        broadcast: vi.fn(),
        exec: async (bin, args) => {
          calls.push([bin, ...args])
          if (args[0] === '--version' && !available.includes(bin)) throw new Error('ENOENT')
          return { stdout: 'ok', stderr: '' }
        }
      })
    expect((await mk(['uv']).installTool()).ok).toBe(true)
    expect(calls.some((c) => c[0] === 'uv' && c.includes('graphifyy'))).toBe(true)
    calls.length = 0
    expect((await mk(['pipx']).installTool()).ok).toBe(true)
    expect(calls.some((c) => c[0] === 'pipx' && c.includes('graphifyy'))).toBe(true)
    const neither = await mk([]).installTool()
    expect(neither.ok).toBe(false)
    expect(neither.log).toContain('graphifyy')
  })
})
