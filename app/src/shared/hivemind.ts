export type HivemindState = 'dormant' | 'not-cloned' | 'ready' | 'error'
export interface HivemindItem {
  kind: 'skill' | 'reference'
  name: string
  description: string
  commit: string
  installed: boolean
  installedCommit: string | null
  updateAvailable: boolean
}
export interface PushableItem {
  kind: 'skill' | 'reference'
  name: string
}
export interface HivemindPayload {
  repo: string
  state: HivemindState
  error: string | null
  headCommit: string | null
  lastSynced: string | null
  items: HivemindItem[]
  pushable: PushableItem[]
}
export type HivemindPushResult = { ok: true; prUrl: string } | { ok: false; error: string }
