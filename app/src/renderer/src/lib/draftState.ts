import type { DraftRecord } from '../../../shared/editorIpc'

export interface DiskSnapshot {
  content: string
  hash: string
}

/** Spec §4.4. `stale` and `conflict` are the same UI with two triggers, so they carry the
 *  same payload and differ only in wording. */
export type DraftBanner =
  | { kind: 'none' }
  | { kind: 'restored'; updatedAt: string }
  | { kind: 'stale'; disk: DiskSnapshot }
  | { kind: 'conflict'; disk: DiskSnapshot }

/**
 * What to show when a tab opens over a draft found on disk.
 *
 * Restore is a banner, not a prompt — the draft always opens, and the only question is whether
 * the file moved underneath it since the draft was taken.
 */
export function bannerOnOpen(draft: DraftRecord | null, disk: DiskSnapshot | null): DraftBanner {
  if (!draft) return { kind: 'none' }
  // No file on disk: a create-mode draft (nothing to be stale against) or an asset deleted
  // while its draft existed (§4.5 orphan — kept, and it still opens).
  if (!disk) return { kind: 'restored', updatedAt: draft.updatedAt }
  if (draft.baseHash === disk.hash) return { kind: 'restored', updatedAt: draft.updatedAt }
  return { kind: 'stale', disk }
}

/**
 * A focus-time re-read of disk (spec §4.4 — no fs watcher).
 *
 * A clean buffer has nothing to lose, so it adopts what is on disk without asking, the way any
 * editor reloads an unmodified file. A dirty buffer raises the banner and lets the user choose.
 */
export function onExternalChange(args: {
  dirty: boolean
  baseHash: string | null
  disk: DiskSnapshot
}): { banner: DraftBanner; reload: boolean } {
  if (args.baseHash === null || args.disk.hash === args.baseHash) {
    return { banner: { kind: 'none' }, reload: false }
  }
  if (!args.dirty) return { banner: { kind: 'none' }, reload: true }
  return { banner: { kind: 'stale', disk: args.disk }, reload: false }
}

/**
 * Was a rejected save a concurrent edit, or something else?
 *
 * Answered by re-reading disk rather than by matching main's error text. That text is not an
 * API, and the create-mode name collision (`"x" already exists`) is thrown from the same hash
 * comparison as the conflict — string matching would confuse the two. A null `disk` means the
 * file could not be read at all, which is not a conflict either.
 */
export function isConflict(baseHash: string | null, disk: DiskSnapshot | null): boolean {
  if (baseHash === null || disk === null) return false
  return disk.hash !== baseHash
}

export type ConflictAction = 'keep-mine' | 'use-disk'

/**
 * Applying the banner's verbs. Both adopt the disk hash: whichever text wins, the next save has
 * to be measured against what is actually on disk right now, or it would be rejected again.
 */
export function resolveConflict(
  action: ConflictAction,
  args: { buffer: string; disk: DiskSnapshot }
): { content: string; baseHash: string; discardDraft: boolean } {
  return action === 'use-disk'
    ? { content: args.disk.content, baseHash: args.disk.hash, discardDraft: true }
    : { content: args.buffer, baseHash: args.disk.hash, discardDraft: false }
}
