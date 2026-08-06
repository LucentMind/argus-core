/**
 * Payload types shared by main (handlers) and renderer (preload consumers) for the
 * memory + skills IPC groups.
 *
 * Deviation from the task brief: the brief's snippet imports `MemoryAuditEntry` /
 * `MemoryTopic` from `../main/services/memory`. `tsconfig.web.json` is a separate
 * composite project (`include`: renderer/src + preload/*.d.ts only) from
 * `tsconfig.node.json` (`include`: main/** + preload/**); pulling in a `main/services`
 * source file from a file reachable by the web project trips the composite project's
 * rootDir containment check. So the two small shapes are duplicated here instead,
 * structurally identical to `main/services/memory.ts`'s `MemoryTopic`/`MemoryAuditEntry`.
 */
import type { MemoryScope } from './memoryScope'

export interface MemoryTopic {
  name: string
  sizeBytes: number
  lastWritten: string
  /** null for a pre-feature or hand-created topic; the UI then shows no chip. */
  scope: MemoryScope | null
}

export interface MemoryTopicsPayload {
  topics: Array<MemoryTopic & { enabled: boolean }>
  indexLines: number
  capLines: number
  /** MEMORY_TOPIC_MAX_BYTES — what an agent write may produce; the user's own edits are free. */
  capBytes: number
}

export interface MemoryAuditEntry {
  ts: string
  caseSlug: string
  topic: string
  indexEntry: string | null
  bytes: number
  /** Absent = agent write (the original shape). UI-driven hygiene actions tag themselves. */
  action?: 'archive' | 'restore'
}

export interface SkillListItem {
  name: string
  tier: 'bundled' | 'user' | 'hivemind'
  description: string
  enabled: boolean
  shadows: string[]
  /** Your fork's content differs from the installed HiveMind copy it shadows. */
  shadowDiverged: boolean
  /** `Name <email>` from frontmatter; null for assets written before authorship, and for packs. */
  author: string | null
}

export interface SkillsPayload {
  skills: SkillListItem[]
}

/** `skills:write`'s result: the list payload plus the hash of what was just written, so the
 *  caller can adopt it as its next `baseHash` instead of retrying against a stale one. */
export interface SkillsWriteResult extends SkillsPayload {
  hash: string
}

export interface SkillReadPayload {
  name: string
  content: string
  /** Optimistic-concurrency token; hand it back to `skills:write`. */
  hash: string
}
