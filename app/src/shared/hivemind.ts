export type HivemindState = 'dormant' | 'not-cloned' | 'ready' | 'error'
export interface HivemindItem {
  kind: 'skill' | 'reference'
  name: string
  description: string
  commit: string
  installed: boolean
  installedCommit: string | null
  /** trust_tier of the locally installed copy (references only; null for skills / not installed). */
  localTier: string | null
  updateAvailable: boolean
}
export interface PushableItem {
  kind: 'skill' | 'reference'
  name: string
}
/** One successful HiveMind push (Tier 2.3) — last push wins; absent key = never pushed. */
export interface PushReceipt {
  prUrl: string
  pushedAt: string
}
export interface HivemindPayload {
  repo: string
  state: HivemindState
  error: string | null
  headCommit: string | null
  lastSynced: string | null
  items: HivemindItem[]
  pushable: PushableItem[]
  /** Push receipts keyed 'skill/<name>' | 'reference/<name>'. */
  pushes: Record<string, PushReceipt>
}
export type HivemindPushResult = { ok: true; prUrl: string } | { ok: false; error: string }
export type HivemindCheckResult = { ok: true } | { ok: false; error: string }
