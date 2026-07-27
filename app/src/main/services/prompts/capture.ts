import fs from 'node:fs'
import path from 'node:path'
import type {
  PromptCaptureListPayload,
  PromptCaptureSummary,
  SessionPromptCapture
} from '../../../shared/promptsIpc'

/** Where captures live, relative to ARGUS_HOME. Dot-prefixed: this is debugging exhaust, not
 *  user data, and it must not show up beside `cases/` and `memory/` in a file browser. */
export const CAPTURE_DIR_REL = '.dev-prompts'

/** Newest sessions retained per case. Per-case, not global: a long-running case must not evict
 *  the only capture of the case you are actually debugging. */
const DEFAULT_MAX_PER_CASE = 50

/** Cap on how many rows `list` returns, across ALL cases. Deliberately a separate constant from
 *  DEFAULT_MAX_PER_CASE: that one bounds a single case's ring buffer (50), this one bounds a
 *  cross-case summary the dev page renders in one screen. Reusing the per-case number as the
 *  global cap silently hid most of the history once more than a couple of cases had captures —
 *  four cases at 50 each already means 150 of 200 records were invisible. 250 keeps truncation
 *  rare without making the dev page read every capture file on a large install. */
const DEFAULT_LIST_LIMIT = 250

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
    const file = path.join(dir, `${c.sessionId}.json`)
    // Unlike the slug/session-id checks above, a failure here must NOT propagate: record() runs
    // synchronously inside the CaseSession constructor (agent/registry.ts does not try/catch it),
    // so an escaping error would fail the session it was only trying to describe. An AV or
    // indexer holding the file open (EPERM on Windows), a full disk, a missing ARGUS_HOME — none
    // of that is worth taking a session down for a disposable debugging capture. Best-effort,
    // surfaced the same way an override-parse failure is at boot (prompts/bootWarnings.ts).
    try {
      fs.mkdirSync(dir, { recursive: true })
      // Not atomic (no temp+rename): a capture is disposable debugging exhaust, and `list`/`read`
      // already skip a malformed file. Paying for atomicity on every session construction would
      // buy nothing.
      fs.writeFileSync(file, JSON.stringify(c, null, 2), 'utf8')
      this.evict(dir)
    } catch (err) {
      console.warn(`[prompts] failed to write capture ${file}:`, err)
    }
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

  list(limit = DEFAULT_LIST_LIMIT): PromptCaptureListPayload {
    if (!this.enabled) return { rows: [], total: 0 }
    const root = this.root()
    let cases: string[]
    try {
      cases = fs
        .readdirSync(root, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? [e.name] : []))
    } catch {
      return { rows: [], total: 0 } // nothing captured yet
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
    // `total` lets the caller say "showing N of total" instead of rendering a truncated list as
    // though it were the whole history.
    return { rows: rows.slice(0, limit), total: rows.length }
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
