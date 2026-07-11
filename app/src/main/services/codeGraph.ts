import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

export function graphsRoot(argusHome: string): string {
  return path.join(argusHome, 'graphs')
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Stable cache identity: remote owner/name when known, else basename + path hash. */
export function repoIdFor(repoPath: string, remote: string | null): string {
  if (remote) {
    const tail = remote
      .replace(/\.git$/i, '')
      .split(/[/:]/)
      .filter(Boolean)
      .slice(-2)
      .join('-')
    const sluggedTail = slug(tail)
    if (sluggedTail) return sluggedTail
  }
  const hash = crypto.createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 8)
  const sluggedBasename = slug(path.basename(repoPath))
  if (!sluggedBasename) return hash
  return `${sluggedBasename}-${hash}`
}

/** '_root' for whole-repo; else a slug of the RELATIVE subpath. Rejects escapes. */
export function scopeKeyFor(scope: string | null): string {
  if (scope == null) return '_root'
  const trimmed = scope.trim().replace(/[\\/]+$/, '')
  if (!trimmed) throw new Error('scope must be a non-empty relative path')
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed))
    throw new Error('scope must be relative to the repo root')
  const parts = trimmed.split(/[\\/]+/)
  if (parts.some((p) => p === '..')) throw new Error('scope must not escape the repo')
  const result = slug(parts.join('-'))
  if (!result) throw new Error('scope reduces to an empty key')
  return result
}

export function graphCacheDir(argusHome: string, repoId: string, scopeKey: string): string {
  return path.join(graphsRoot(argusHome), repoId, scopeKey)
}

export interface GraphMeta {
  commit: string
  branch: string
  scope: string | null
  builtAt: string
  graphifyVersion: string | null
  nodeCount: number | null
  edgeCount: number | null
  status: 'ok' | 'failed'
  error?: string
}

export function readMeta(cacheDir: string): GraphMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf8')) as GraphMeta
  } catch {
    return null
  }
}

export function writeMeta(cacheDir: string, meta: GraphMeta): void {
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'meta.json'), JSON.stringify(meta, null, 2))
}

/** graphify extract prints: "... wrote <path>/graph.json: N nodes, M edges, K communities" */
export function parseExtractCounts(stdout: string): { nodes: number | null; edges: number | null } {
  const m = /graph\.json:\s*(\d+) nodes, (\d+) edges/.exec(stdout)
  return m ? { nodes: Number(m[1]), edges: Number(m[2]) } : { nodes: null, edges: null }
}

const execFileAsync = promisify(execFile)
const BUILD_TIMEOUT_MS = 30 * 60 * 1000
const GIT_TIMEOUT_MS = 15_000

type Exec = NonNullable<CodeGraphDeps['exec']>

export interface GraphStatusRow {
  scope: string | null
  scopeKey: string
  status: 'ok' | 'failed' | 'building' | 'none'
  commit: string | null
  behind: number | null
  builtAt: string | null
  nodeCount: number | null
  error?: string
}

export interface CodeGraphDeps {
  argusHome: string
  pathOf: (id: string) => string | null
  recompute: () => void
  broadcast: (channel: string, payload: unknown) => void
  exec?: (
    bin: string,
    args: string[],
    opts: { timeout: number; cwd?: string }
  ) => Promise<{ stdout: string; stderr: string }>
}

export class CodeGraphService {
  private exec: Exec
  /** key = resolved repoPath + '::' + scopeKey → in-flight build */
  private inFlight = new Map<string, Promise<void>>()

  constructor(private deps: CodeGraphDeps) {
    this.exec = deps.exec ?? ((bin, args, opts) => execFileAsync(bin, args, opts))
  }

  /** Always real execFile (never the injected exec): tests build real git fixture repos. */
  private async git(repoPath: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { timeout: GIT_TIMEOUT_MS, cwd: repoPath })
    return stdout.trim()
  }

  private key(repoPath: string, scopeKey: string): string {
    return `${path.resolve(repoPath)}::${scopeKey}`
  }

  build(repoPath: string, scope: string | null): { started: boolean; missing?: true } {
    const bin = this.deps.pathOf('graphify')
    if (!bin) return { started: false, missing: true }
    if (!fs.existsSync(repoPath)) throw new Error(`repo path not found: ${repoPath}`)
    const scopeKey = scopeKeyFor(scope) // throws on hostile scopes — IPC surfaces the message
    const k = this.key(repoPath, scopeKey)
    if (this.inFlight.has(k)) return { started: true } // coalesce
    const run = this.runBuild(bin, repoPath, scope, scopeKey).finally(() => {
      this.inFlight.delete(k)
      this.deps.broadcast('graph:building', { repoPath, scope, active: false })
      this.deps.broadcast('graph:changed', { repoPath })
    })
    this.inFlight.set(k, run)
    this.deps.broadcast('graph:building', { repoPath, scope, active: true })
    run.catch((err) => console.warn(`[graph] build failed: ${(err as Error).message}`))
    return { started: true }
  }

  private async runBuild(
    bin: string,
    repoPath: string,
    scope: string | null,
    scopeKey: string
  ): Promise<void> {
    const remote = await this.git(repoPath, 'remote', 'get-url', 'origin').catch(() => null)
    const cacheDir = graphCacheDir(this.deps.argusHome, repoIdFor(repoPath, remote), scopeKey)
    fs.mkdirSync(cacheDir, { recursive: true })
    const [commit, branch] = await Promise.all([
      this.git(repoPath, 'rev-parse', 'HEAD'),
      this.git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')
    ])
    const target = scope ? path.join(repoPath, scope.trim()) : repoPath
    const base: Omit<GraphMeta, 'status' | 'nodeCount' | 'edgeCount' | 'graphifyVersion'> = {
      commit,
      branch,
      scope,
      builtAt: new Date().toISOString()
    }
    try {
      const version = await this.exec(bin, ['--version'], { timeout: GIT_TIMEOUT_MS })
        .then((r) => r.stdout.trim())
        .catch(() => null)
      const { stdout, stderr } = await this.exec(
        bin,
        ['extract', target, '--code-only', '--out', cacheDir],
        { timeout: BUILD_TIMEOUT_MS }
      )
      fs.writeFileSync(path.join(cacheDir, 'build.log'), stdout + '\n' + stderr)
      const counts = parseExtractCounts(stdout)
      writeMeta(cacheDir, {
        ...base,
        graphifyVersion: version,
        nodeCount: counts.nodes,
        edgeCount: counts.edges,
        status: 'ok'
      })
    } catch (err) {
      const msg = (err as Error).message
      fs.writeFileSync(path.join(cacheDir, 'build.log'), msg)
      writeMeta(cacheDir, {
        ...base,
        graphifyVersion: null,
        nodeCount: null,
        edgeCount: null,
        status: 'failed',
        error: msg
      })
      throw err
    }
  }

  async status(repoPath: string): Promise<GraphStatusRow[]> {
    const remote = await this.git(repoPath, 'remote', 'get-url', 'origin').catch(() => null)
    const repoDir = path.join(graphsRoot(this.deps.argusHome), repoIdFor(repoPath, remote))
    const scopeKeys = fs.existsSync(repoDir)
      ? fs
          .readdirSync(repoDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : []
    // in-flight builds may target a scopeKey with no dir yet
    for (const k of this.inFlight.keys()) {
      const [p, sk] = k.split('::')
      if (p === path.resolve(repoPath) && !scopeKeys.includes(sk)) scopeKeys.push(sk)
    }
    if (scopeKeys.length === 0) {
      return [
        {
          scope: null,
          scopeKey: '_root',
          status: 'none',
          commit: null,
          behind: null,
          builtAt: null,
          nodeCount: null
        }
      ]
    }
    const head = await this.git(repoPath, 'rev-parse', 'HEAD').catch(() => null)
    return Promise.all(
      scopeKeys.sort().map(async (scopeKey): Promise<GraphStatusRow> => {
        if (this.inFlight.has(this.key(repoPath, scopeKey))) {
          return {
            scope: null,
            scopeKey,
            status: 'building',
            commit: null,
            behind: null,
            builtAt: null,
            nodeCount: null
          }
        }
        const meta = readMeta(path.join(repoDir, scopeKey))
        if (!meta) {
          return {
            scope: null,
            scopeKey,
            status: 'none',
            commit: null,
            behind: null,
            builtAt: null,
            nodeCount: null
          }
        }
        const behind =
          head && meta.commit
            ? await this.git(repoPath, 'rev-list', '--count', `${meta.commit}..HEAD`)
                .then(Number)
                .catch(() => null)
            : null
        return {
          scope: meta.scope,
          scopeKey,
          status: meta.status,
          commit: meta.commit,
          behind,
          builtAt: meta.builtAt,
          nodeCount: meta.nodeCount,
          error: meta.error
        }
      })
    )
  }

  async installTool(): Promise<{ ok: boolean; log: string }> {
    const has = async (bin: string): Promise<boolean> =>
      this.exec(bin, ['--version'], { timeout: GIT_TIMEOUT_MS }).then(
        () => true,
        () => false
      )
    const attempt = async (bin: string, args: string[]): Promise<{ ok: boolean; log: string }> => {
      try {
        const { stdout, stderr } = await this.exec(bin, args, { timeout: 5 * 60 * 1000 })
        this.deps.recompute()
        return { ok: true, log: `${bin} ${args.join(' ')}\n${stdout}\n${stderr}`.trim() }
      } catch (err) {
        return { ok: false, log: (err as Error).message }
      }
    }
    if (await has('uv')) return attempt('uv', ['tool', 'install', 'graphifyy'])
    if (await has('pipx')) return attempt('pipx', ['install', 'graphifyy'])
    return {
      ok: false,
      log: 'Neither uv nor pipx found. Install manually: uv tool install graphifyy (or pipx install graphifyy), then set the path in Settings → Analysis Tools.'
    }
  }
}
