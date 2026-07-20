import fs from 'node:fs'
import path from 'node:path'
import { memoryArchiveDir, memoryAuditPath, memoryDir, memoryIndexPath } from './paths'
import {
  MEMORY_INDEX_MAX_LINES,
  indexLineFor,
  isValidMemoryTopic,
  readAudit,
  readIndex,
  type MemoryAuditEntry
} from './memory'

export interface HygieneConfig {
  staleDays: number
  minRecalls: number
  trackingStartedAt: string
}

export interface TopicUsage {
  lastRecalledAt: string | null
  lastWrittenAt: string | null
  recallCount: number
}

export interface ArchivedTopic {
  topic: string
  archivedAt: string | null
  sizeBytes: number
}

const DAY_MS = 86_400_000

/** Spec §3: stale = idle beyond staleDays AND under minRecalls AND grace period elapsed.
 *  An unstamped epoch (pre-feature settings) flags nothing — fail quiet, not loud. */
export function isStaleCandidate(u: TopicUsage, cfg: HygieneConfig, now: Date): boolean {
  if (!cfg.trackingStartedAt) return false
  const windowMs = cfg.staleDays * DAY_MS
  if (now.getTime() - Date.parse(cfg.trackingStartedAt) <= windowMs) return false
  if (u.recallCount >= cfg.minRecalls) return false
  const lastUsed = Math.max(
    u.lastRecalledAt ? Date.parse(u.lastRecalledAt) : 0,
    u.lastWrittenAt ? Date.parse(u.lastWrittenAt) : 0
  )
  return now.getTime() - lastUsed > windowMs
}

function appendAudit(argusHome: string, entry: MemoryAuditEntry): void {
  fs.mkdirSync(memoryDir(argusHome), { recursive: true })
  fs.appendFileSync(memoryAuditPath(argusHome), JSON.stringify(entry) + '\n')
}

/** Move memory/<topic>.md → memory/archive/, drop its _index.md line (saved into the audit
 *  entry so restore is faithful). Ordered for recoverability: a failed index edit rolls the
 *  file move back. User-triggered only (spec §3). */
export function archiveTopic(argusHome: string, topic: string): void {
  if (!isValidMemoryTopic(topic)) throw new Error(`Invalid topic: ${topic}`)
  const live = path.join(memoryDir(argusHome), `${topic}.md`)
  if (!fs.existsSync(live)) throw new Error(`No such topic: ${topic}`)
  const dest = path.join(memoryArchiveDir(argusHome), `${topic}.md`)
  if (fs.existsSync(dest)) throw new Error(`Already archived: ${topic}`)
  const idx = readIndex(argusHome) // read BEFORE the rename — an unreadable index aborts cleanly
  const lineRe = indexLineFor(topic)
  const savedLine = idx.split('\n').find((l) => lineRe.test(l)) ?? null
  fs.mkdirSync(memoryArchiveDir(argusHome), { recursive: true })
  fs.renameSync(live, dest)
  try {
    if (savedLine !== null) {
      fs.writeFileSync(
        memoryIndexPath(argusHome),
        idx
          .split('\n')
          .filter((l) => !lineRe.test(l))
          .join('\n')
      )
    }
  } catch (err) {
    fs.renameSync(dest, live) // roll back — a failed archive must not half-apply
    throw err
  }
  appendAudit(argusHome, {
    ts: new Date().toISOString(),
    caseSlug: 'ui',
    topic,
    indexEntry: savedLine,
    bytes: 0,
    action: 'archive'
  })
}

/** Reverse of archiveTopic. Rejected when a live namesake exists (spec §3 collision rule). */
export function restoreTopic(argusHome: string, topic: string): void {
  if (!isValidMemoryTopic(topic)) throw new Error(`Invalid topic: ${topic}`)
  const arch = path.join(memoryArchiveDir(argusHome), `${topic}.md`)
  if (!fs.existsSync(arch)) throw new Error(`Not archived: ${topic}`)
  const live = path.join(memoryDir(argusHome), `${topic}.md`)
  if (fs.existsSync(live)) {
    throw new Error(`A live topic named "${topic}" already exists — resolve manually`)
  }
  // readAudit returns newest-first, so .find() is the most recent archive of this topic.
  const saved =
    readAudit(argusHome, 100_000).find((e) => e.topic === topic && e.action === 'archive')
      ?.indexEntry ?? null
  fs.renameSync(arch, live)
  try {
    if (saved) {
      const lines = readIndex(argusHome)
        .split('\n')
        .filter((l) => l.trim() !== '')
      if (
        !lines.some((l) => indexLineFor(topic).test(l)) &&
        lines.length < MEMORY_INDEX_MAX_LINES
      ) {
        fs.writeFileSync(memoryIndexPath(argusHome), [...lines, saved].join('\n') + '\n')
      }
    }
  } catch (err) {
    fs.renameSync(live, arch)
    throw err
  }
  appendAudit(argusHome, {
    ts: new Date().toISOString(),
    caseSlug: 'ui',
    topic,
    indexEntry: saved,
    bytes: 0,
    action: 'restore'
  })
}

export function listArchivedTopics(argusHome: string): ArchivedTopic[] {
  const dir = memoryArchiveDir(argusHome)
  if (!fs.existsSync(dir)) return []
  const audit = readAudit(argusHome, 100_000)
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const topic = f.slice(0, -3)
      return {
        topic,
        archivedAt: audit.find((e) => e.topic === topic && e.action === 'archive')?.ts ?? null,
        sizeBytes: fs.statSync(path.join(dir, f)).size
      }
    })
    .sort((a, b) => a.topic.localeCompare(b.topic))
}
