import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { draftsDir } from './paths'
import type { AuthoringKind } from '../../shared/authoringIpc'
import type { DraftChange, DraftRecord, DraftRef } from '../../shared/editorIpc'

function hash16(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)
}

/**
 * First 16 hex chars of sha256("<kind>:<name>"). Edit-mode identity: the file on disk really is
 * addressed by kind+name, so a rename really is a different asset.
 *
 * Hashed rather than escaped: reference names carry ".md", skill names are folder names, and
 * nothing guarantees either stays flat forever — escaping is a filename-bug generator. The
 * real identity lives in the record body, which is what `read` hands back.
 */
export function draftKey(kind: AuthoringKind, name: string): string {
  return hash16(`${kind}:${name}`)
}

/**
 * Dispatches a `DraftRef` to its storage key.
 *
 * Create-mode drafts do NOT key by kind+name: the name is a field the user is actively typing,
 * so every keystroke would be a rename, and two create drafts that happen to land on the same
 * typed name would silently overwrite one another (the defect this scheme replaces). Create-mode
 * identity is instead a stable id, minted once when the tab opens and carried in the record body,
 * independent of what gets typed. Edit-mode identity has no such problem — the file itself is the
 * identity — so it keeps the kind+name key unchanged.
 */
export function keyOf(ref: DraftRef): string {
  // Truthiness, not `in` — matches how `queue()` decides whether a `DraftChange` counts as
  // create-mode-identified (`change.draftId ? ... : change`). `{ draftId: '' }` — the key present
  // but empty — is unreachable today (queue's only non-id ref is a whole `DraftChange`, which
  // always carries kind+name too), but keeping both checks in the same style means an empty id
  // can never key one bucket here and a different one in `queue()`.
  if ('draftId' in ref && ref.draftId) return hash16(`draft:${ref.draftId}`)
  const { kind, name } = ref as { kind: AuthoringKind; name: string }
  return draftKey(kind, name)
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

  read(ref: DraftRef): DraftRecord | null {
    const key = keyOf(ref)
    // The queued copy is up to `debounceMs` newer than disk. A read that ignored it would hand
    // a stale buffer to a tab reopened moments after it was closed.
    return this.pending.get(key) ?? this.readFile(key)
  }

  queue(change: DraftChange): void {
    // Create mode carries its own stable id; edit mode's identity is still kind+name. See
    // `keyOf` for why the two schemes differ.
    const key = keyOf(change.draftId ? { draftId: change.draftId } : change)
    this.pending.set(key, {
      kind: change.kind,
      name: change.name,
      mode: change.mode,
      content: change.content,
      baseHash: change.baseHash,
      ...(change.draftId ? { draftId: change.draftId } : {}),
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
      this.flushKey(key)
    }
  }

  /**
   * Atomically adopt a legacy (pre-draftId) create-mode draft onto its id-keyed replacement:
   * queue the new record, write **only that key**, synchronously, and discard the legacy key
   * only once that write actually lands. If the write fails, both the queued new record and the
   * legacy file are left exactly as they were — the next attempt (a keystroke re-arming the
   * debounce, or `flushAll()` on quit) still has the legacy copy to recover from.
   *
   * Replaces a renderer-side "queue the new one (debounced), then delete the old one immediately"
   * sequence, which left a window — up to `debounceMs` wide, unbounded if the write kept failing
   * — where the content existed only in this store's in-memory `pending` map and nowhere on disk.
   * Returns whether the write landed, so the caller knows whether the adoption actually happened.
   */
  adopt(legacy: DraftRef, change: DraftChange & { draftId: string }): boolean {
    const key = keyOf({ draftId: change.draftId })
    this.queue(change)
    this.flushKey(key)
    if (this.pending.has(key)) {
      // writeKey already logged the failure and left the record queued (persist-before-adopt's
      // failure half, same as any other write). Leave the legacy key alone too.
      return false
    }
    this.discard(legacy)
    return true
  }

  /**
   * Every draft currently known. Added for the resumable-drafts banner (spec §4.5 pulled
   * forward): a create-mode tab needs to find drafts filed under names other than its own.
   *
   * Disk copies first, then the pending map merged over them — same reasoning as `read()`: a
   * queued change is up to `debounceMs` newer than what made it to disk.
   */
  list(): DraftRecord[] {
    const byKey = new Map<string, DraftRecord>()
    let entries: string[] = []
    try {
      entries = fs.readdirSync(this.dir)
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const key = entry.slice(0, -'.json'.length)
      const rec = this.readFile(key)
      if (rec) byKey.set(key, rec)
    }
    for (const [key, rec] of this.pending) byKey.set(key, rec)
    return [...byKey.values()]
  }

  discard(ref: DraftRef): void {
    const key = keyOf(ref)
    this.cancel(key)
    this.pending.delete(key)
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

  /** Cancel a key's pending debounce timer, if any, and write it now. Shared by `flushAll()`
   *  (every key) and `adopt()` (exactly one). */
  private flushKey(key: string): void {
    this.cancel(key)
    this.writeKey(key)
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
    this.saved?.(rec)
  }
}
