import fs from 'node:fs'
import path from 'node:path'
import type { PromptCaptureSummary, SessionPromptCapture } from '../../../shared/promptsIpc'

/** Where captures live, relative to ARGUS_HOME. Dot-prefixed: this is debugging exhaust, not
 *  user data, and it must not show up beside `cases/` and `memory/` in a file browser. */
export const CAPTURE_DIR_REL = '.dev-prompts'

/** Newest sessions retained per case. Per-case, not global: a long-running case must not evict
 *  the only capture of the case you are actually debugging. */
const DEFAULT_MAX_PER_CASE = 50

/** Case slugs reach `read` straight off IPC, which is untyped at runtime. Slugs are generated
 *  filesystem-safe (`caseDir`), so anything else is either a bug or an attempt to escape. */
const SAFE_SLUG = /^[A-Za-z0-9._-]+$/

/** `.` and `..` both satisfy SAFE_SLUG's character class — it allows `.` so a dots-only string
 *  passes — but `path.join(root, '..')` escapes the capture dir entirely (and `.` is a no-op
 *  alias for it), so they need an explicit call-out the regex alone can't provide. Kept as the
 *  single gate both `record` and `read` route through, so the rule can't drift between them. */
function isSafeSlug(slug: string): boolean {
  return SAFE_SLUG.test(slug) && slug !== '.' && slug !== '..'
}

/** sessionId reaches `read` straight off IPC too, and is interpolated directly into a path
 *  segment (`${sessionId}.json`) with no other sanitization — anything other than a
 *  non-negative safe integer is a traversal vector (e.g. `../../config`) or nonsense. */
function isSafeSessionId(id: number): boolean {
  return Number.isSafeInteger(id) && id >= 0
}

export interface PromptCaptureStoreDeps {
  /** The dev-tools gate result. Load-bearing: with it off, nothing is written or read. */
  devTools: boolean
  argusHome: string
  /** Ring-buffer size per case. Injectable so the eviction test does not write 50 files. */
  max?: number
}

/**
 * Per-session prompt captures (spec §4).
 *
 * With the gate off this is inert in both directions: `record` returns immediately without so
 * much as creating the directory, and `list`/`read` report nothing. The harness additionally
 * omits the `capturePrompt` callback entirely in that case, so a normal build never even
 * assembles a record — this guard is the second line, not the only one.
 */
export class PromptCaptureStore {
  constructor(private deps: PromptCaptureStoreDeps) {}

  get enabled(): boolean {
    return this.deps.devTools
  }

  private root(): string {
    return path.join(this.deps.argusHome, CAPTURE_DIR_REL)
  }

  private caseDirFor(slug: string): string | null {
    if (!isSafeSlug(slug)) return null
    return path.join(this.root(), slug)
  }

  record(c: SessionPromptCapture): void {
    if (!this.enabled) return
    const dir = this.caseDirFor(c.caseSlug)
    // A throw here is right: this is a write path with a value the harness controls, so an
    // unsafe slug or session id is a bug worth surfacing, not a silent no-op.
    if (!dir) throw new Error(`unsafe case slug for prompt capture: ${c.caseSlug}`)
    if (!isSafeSessionId(c.sessionId)) {
      throw new Error(`unsafe session id for prompt capture: ${c.sessionId}`)
    }
    fs.mkdirSync(dir, { recursive: true })
    // Not atomic (no temp+rename): a capture is disposable debugging exhaust, and `list`/`read`
    // already skip a malformed file. Paying for atomicity on every session construction would
    // buy nothing.
    fs.writeFileSync(path.join(dir, `${c.sessionId}.json`), JSON.stringify(c, null, 2), 'utf8')
    this.evict(dir)
  }

  /** Keep the newest `max` session ids in one case dir. Ordered by session id, which is a
   *  monotonic DB rowid — more reliable than mtime, which a file copy or restore resets. */
  private evict(dir: string): void {
    const max = this.deps.max ?? DEFAULT_MAX_PER_CASE
    const ids = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => Number(f.slice(0, -'.json'.length)))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a)
    for (const id of ids.slice(max)) {
      try {
        fs.unlinkSync(path.join(dir, `${id}.json`))
      } catch {
        /* already gone — eviction is best-effort */
      }
    }
  }

  read(caseSlug: string, sessionId: number): SessionPromptCapture | null {
    if (!this.enabled) return null
    const dir = this.caseDirFor(caseSlug)
    if (!dir) return null
    // Unlike `record`, bad input here is just a miss: sessionId arrives off IPC, untyped.
    if (!isSafeSessionId(sessionId)) return null
    return readRecord(path.join(dir, `${sessionId}.json`))
  }

  list(limit = DEFAULT_MAX_PER_CASE): PromptCaptureSummary[] {
    if (!this.enabled) return []
    const root = this.root()
    let cases: string[]
    try {
      cases = fs
        .readdirSync(root, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? [e.name] : []))
    } catch {
      return [] // nothing captured yet
    }
    const rows: PromptCaptureSummary[] = []
    for (const slug of cases) {
      const dir = path.join(root, slug)
      let files: string[]
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      } catch {
        continue
      }
      for (const f of files) {
        const c = readRecord(path.join(dir, f))
        if (!c) continue
        rows.push({
          caseSlug: c.caseSlug,
          sessionId: c.sessionId,
          createdAt: c.createdAt,
          driverKind: c.driverKind,
          mode: c.mode,
          transport: c.transport,
          chars: c.systemAppend.length,
          overrideCount: c.activeOverrides.length
        })
      }
    }
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    return rows.slice(0, limit)
  }
}

/** Read one capture file. A missing, unreadable or malformed file is `null`, never a throw: the
 *  app can be killed mid-write, and one truncated file must not blank the whole tab. */
function readRecord(file: string): SessionPromptCapture | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SessionPromptCapture
  } catch {
    return null
  }
}
