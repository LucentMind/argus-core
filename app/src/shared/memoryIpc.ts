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
export interface MemoryTopic {
  name: string
  sizeBytes: number
  lastWritten: string
}

export interface MemoryTopicsPayload {
  topics: Array<MemoryTopic & { enabled: boolean }>
  indexLines: number
  capLines: number
}

export interface MemoryAuditEntry {
  ts: string
  caseSlug: string
  topic: string
  indexEntry: string | null
  bytes: number
}

export interface SkillListItem {
  name: string
  tier: 'bundled' | 'user' | 'hivemind'
  description: string
  enabled: boolean
  shadows: string[]
}

export interface SkillsPayload {
  skills: SkillListItem[]
}
