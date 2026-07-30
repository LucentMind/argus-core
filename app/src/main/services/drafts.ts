import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { draftsDir } from './paths'
import type { AuthoringKind } from '../../shared/authoringIpc'
import type { DraftChange, DraftRecord } from '../../shared/editorIpc'

/**
 * First 16 hex chars of sha256("<kind>:<name>").
 *
 * Hashed rather than escaped: reference names carry ".md", skill names are folder names, and
 * nothing guarantees either stays flat forever — escaping is a filename-bug generator. The
 * real identity lives in the record body, which is what `read` hands back.
 */
export function draftKey(kind: AuthoringKind, name: string): string {
  return crypto.createHash('sha256').update(`${kind}:${name}`, 'utf8').digest('hex').slice(0, 16)
}

export interface DraftStoreDeps {
  argusHome: string
  /** Idle window before a queued change is written (spec §4.2). */
  debounceMs?: number
  /** Injected so tests get a deterministic `updatedAt`; house DI convention. */
  now?: () => Date
}

/**
 * Autosaved editor buffers, one JSON file per draft.
 *
 * The debounce lives here in main rather than in the renderer, deliberately. Increment 1 made
 * the editor a dependent child: closing the main window destroys the editor renderer *before*
 * `before-quit` fires, so a renderer-side flush would have nobody to ask on the ordinary exit
 * path. Owning the timer here makes `flushAll()` synchronous and independent of whether the
 * window is still alive.
 */
export class DraftStore {
  private readonly dir: string
  private readonly debounceMs: number
  private readonly now: () => Date
  private pending = new Map<string, DraftRecord>()
  private timers = new Map<string, NodeJS.Timeout>()
  /** newKey → the keys it has replaced, all deleted once newKey lands. */
  private superseded = new Map<string, Set<string>>()
  private saved: ((rec: DraftRecord) => void) | null = null

  constructor(deps: DraftStoreDeps) {
    this.dir = draftsDir(deps.argusHome)
    this.debounceMs = deps.debounceMs ?? 500
    this.now = deps.now ?? ((): Date => new Date())
  }

  /** Notified after each successful write. Persist-before-adopt: this is what the UI is
   *  allowed to believe, and it fires strictly after the rename. */
  onSaved(cb: (rec: DraftRecord) => void): void {
    this.saved = cb
  }

  read(kind: AuthoringKind, name: string): DraftRecord | null {
    const key = draftKey(kind, name)
    // The queued copy is up to `debounceMs` newer than disk. A read that ignored it would hand
    // a stale buffer to a tab reopened moments after it was closed.
    return this.pending.get(key) ?? this.readFile(key)
  }

  queue(change: DraftChange): void {
    const key = draftKey(change.kind, change.name)
    if (change.replaces) {
      const oldKey = draftKey(change.replaces.kind, change.replaces.name)
      if (oldKey !== key) {
        this.cancel(oldKey)
        this.pending.delete(oldKey)
        const stranded = this.superseded.get(key) ?? new Set<string>()
        stranded.add(oldKey)
        // Absorb whatever the old key had itself superseded. A second rename inside one
        // debounce window means the old key's write never fired, so its own ancestors are
        // still on disk and nothing else will ever delete them.
        for (const ancestor of this.superseded.get(oldKey) ?? []) stranded.add(ancestor)
        this.superseded.delete(oldKey)
        // A chain that returns to a name it already used (a → b → a) would otherwise list
        // the live key as stranded and delete the file it just wrote.
        stranded.delete(key)
        this.superseded.set(key, stranded)
      }
    }
    // Built field by field rather than spread-minus-`replaces`: `replaces` is wire-only routing
    // and must never reach the file.
    this.pending.set(key, {
      kind: change.kind,
      name: change.name,
      mode: change.mode,
      content: change.content,
      baseHash: change.baseHash,
      updatedAt: this.now().toISOString()
    })
    this.cancel(key)
    const t = setTimeout(() => this.writeKey(key), this.debounceMs)
    t.unref?.()
    this.timers.set(key, t)
  }

  /** Write everything queued, now. Synchronous on purpose — the quit path cannot await. */
  flushAll(): void {
    for (const key of [...this.pending.keys()]) {
      this.cancel(key)
      this.writeKey(key)
    }
  }

  discard(kind: AuthoringKind, name: string): void {
    const key = draftKey(kind, name)
    this.cancel(key)
    this.pending.delete(key)
    const stranded = this.superseded.get(key)
    this.superseded.delete(key)
    // The stranded ancestors are the same logical draft under names the user abandoned mid-
    // rename; discarding the live key must take them with it.
    for (const old of stranded ?? []) {
      try {
        fs.rmSync(this.file(old))
      } catch {
        /* never written, or already gone */
      }
    }
    try {
      fs.rmSync(this.file(key))
    } catch {
      /* never written, or already gone */
    }
    // Finding 4: `writeKey` writes `<key>.json.tmp` before renaming it onto `<key>.json`. If the
    // rename itself throws, the temp file is left behind and nothing else ever sweeps it —
    // discard is the one place a stale draft's lifetime is known to end, so it has to take the
    // temp file with it too, tolerating absence exactly like the file above.
    try {
      fs.rmSync(this.tmpFile(key))
    } catch {
      /* never written, or already renamed away */
    }
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`)
  }

  private tmpFile(key: string): string {
    return `${this.file(key)}.tmp`
  }

  private readFile(key: string): DraftRecord | null {
    let raw: string
    try {
      raw = fs.readFileSync(this.file(key), 'utf8')
    } catch {
      return null
    }
    try {
      const rec = JSON.parse(raw) as Partial<DraftRecord>
      // A truncated write or a hand-edited file must not take the editor window down on open.
      if (typeof rec?.content !== 'string' || typeof rec?.name !== 'string') return null
      return rec as DraftRecord
    } catch {
      return null
    }
  }

  private cancel(key: string): void {
    const t = this.timers.get(key)
    if (t) {
      clearTimeout(t)
      this.timers.delete(key)
    }
  }

  private writeKey(key: string): void {
    this.timers.delete(key)
    const rec = this.pending.get(key)
    if (!rec) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = this.tmpFile(key)
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8')
      fs.renameSync(tmp, this.file(key))
    } catch (err) {
      // Persist-before-adopt, the failure half: the queued copy is the only remaining record of
      // these bytes, so it stays queued. The next keystroke re-arms the timer, and flushAll on
      // quit gets one last attempt. Deleting it here would lose the edit silently.
      //
      // Finding 5: a persistent failure (permissions, disk full) used to be signalled only by
      // the *absence* of a "Draft ·" chip in the window — unactionable for a user and
      // untriageable for a developer, which undercuts this feature's whole premise that the
      // text is safe. Logged, not surfaced to the renderer: the requeue-and-retry behavior above
      // is unchanged, this only makes a failure that keeps happening visible somewhere.
      console.error(`[drafts] write failed for ${key}`, err)
      return
    }
    this.pending.delete(key)
    const stranded = this.superseded.get(key)
    if (stranded) {
      // §4.5 ordering: the new key is on disk before any old one goes, so a crash between
      // the two leaves two drafts rather than none.
      for (const old of stranded) {
        try {
          fs.rmSync(this.file(old))
        } catch {
          /* the rename happened before this key was ever written */
        }
      }
      this.superseded.delete(key)
    }
    this.saved?.(rec)
  }
}
