import fs from 'node:fs'
import path from 'node:path'
import { memoryAuditPath, memoryDir, memoryIndexPath } from './paths'
import { topicEnabled, type AgentAccess } from '../../shared/agentAccess'

export const MEMORY_INDEX_MAX_LINES = 200

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Single source of truth for what a memory topic name may look like — backs both
 * topicPath's validation here and staging.ts's pre-validation pass, so a distiller
 * output that would later hard-fail in applyMemoryWrite is instead caught (and
 * reported) before anything is staged.
 */
export function isValidMemoryTopic(topic: string): boolean {
  return TOPIC_RE.test(topic)
}

export interface MemoryTopic {
  name: string
  sizeBytes: number
  lastWritten: string
}

export interface MemoryAuditEntry {
  ts: string
  caseSlug: string
  topic: string
  indexEntry: string | null
  bytes: number
}

function topicPath(argusHome: string, name: string): string {
  if (name === '_index') return memoryIndexPath(argusHome)
  if (!TOPIC_RE.test(name)) throw new Error(`Invalid memory topic name ${JSON.stringify(name)}`)
  return path.join(memoryDir(argusHome), `${name}.md`)
}

/** Matches the markdown index-link line for a given topic, anchored at line start so free
 *  text elsewhere on the line (e.g. a description mentioning another topic's filename) can't
 *  cause a false match. */
function indexLineFor(name: string): RegExp {
  return new RegExp(`^-\\s*\\[[^\\]]*\\]\\(${name}\\.md\\)`)
}

/**
 * Strip a leading echo of the topic name from an index entry, so the rendered line reads
 * `- [nav-fusion-drift](nav-fusion-drift.md) — bearing errors follow an IMU warning`
 * rather than repeating the slug a third time. Models routinely open `indexEntry` with the
 * topic (and the fallback in distill/staging.ts derives it from the content's first line,
 * which often does the same), while the markdown link already shows it twice.
 *
 * Matches the slug either verbatim or space-separated (`nav fusion drift`), case-insensitively,
 * followed by an em/en dash, hyphen, or colon separator. A leading capital on the remainder is
 * lowered only when the entry looked like a sentence continuation, never mid-acronym.
 */
export function stripTopicEcho(topic: string, indexEntry: string): string {
  const slug = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-\\s]')
  const m = indexEntry.match(new RegExp(`^\\s*${slug}\\s*(?:[—–\\-:]+)\\s*(.+)$`, 'i'))
  const rest = m?.[1]?.trim()
  // Refuse to strip when nothing meaningful survives — a bare topic-name entry is still
  // more useful than an empty one.
  return rest ? rest : indexEntry.trim()
}

export function listTopics(argusHome: string): MemoryTopic[] {
  const dir = memoryDir(argusHome)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== '_index.md')
    .map((f) => {
      const st = fs.statSync(path.join(dir, f))
      return { name: f.slice(0, -3), sizeBytes: st.size, lastWritten: st.mtime.toISOString() }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function readIndex(argusHome: string): string {
  const p = memoryIndexPath(argusHome)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

export function readTopic(argusHome: string, name: string): string {
  const p = topicPath(argusHome, name)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

export function writeTopicFile(argusHome: string, name: string, content: string): void {
  const p = topicPath(argusHome, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

export function deleteTopic(argusHome: string, name: string): void {
  const p = topicPath(argusHome, name)
  if (name === '_index') throw new Error('Cannot delete the memory index')
  if (fs.existsSync(p)) fs.rmSync(p)
  const idx = readIndex(argusHome)
  const lineRe = indexLineFor(name)
  if (idx.split('\n').some((l) => lineRe.test(l))) {
    const kept = idx.split('\n').filter((l) => !lineRe.test(l))
    fs.writeFileSync(memoryIndexPath(argusHome), kept.join('\n'))
  }
}

/** Backend for the write_memory native tool. Appends content; maintains the index; audits. */
export function applyMemoryWrite(
  argusHome: string,
  caseSlug: string,
  input: { topic: string; content: string; indexEntry?: string }
): string {
  const { topic, content } = input
  if (topic === '_index') {
    throw new Error('write_memory: "_index" is a reserved topic name and cannot be written to')
  }
  const p = topicPath(argusHome, topic) // validates the name
  if (!content.trim()) throw new Error('write_memory: content must not be empty')

  const indexEntry = input.indexEntry?.trim() || null
  if (indexEntry) {
    if (/[\r\n]/.test(indexEntry)) {
      throw new Error('write_memory: index_entry must be a single line (no interior newlines)')
    }
    if (indexEntry.length > 200) {
      throw new Error('write_memory: index_entry must be at most 200 characters')
    }
    const idx = readIndex(argusHome)
    const lines = idx.split('\n').filter((l) => l.trim() !== '')
    const lineRe = indexLineFor(topic)
    const has = lines.some((l) => lineRe.test(l))
    if (!has && lines.length >= MEMORY_INDEX_MAX_LINES) {
      throw new Error(
        `write_memory: _index.md is at its ${MEMORY_INDEX_MAX_LINES}-line cap — consolidate existing topics instead of adding new index entries`
      )
    }
    if (!has) {
      fs.mkdirSync(memoryDir(argusHome), { recursive: true })
      fs.writeFileSync(
        memoryIndexPath(argusHome),
        [...lines, `- [${topic}](${topic}.md) — ${stripTopicEcho(topic, indexEntry)}`].join('\n') +
          '\n'
      )
    }
  }

  fs.mkdirSync(memoryDir(argusHome), { recursive: true })
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
  const block = existing
    ? `${existing.replace(/\n+$/, '')}\n\n${content.trim()}\n`
    : `${content.trim()}\n`
  fs.writeFileSync(p, block)

  const entry: MemoryAuditEntry = {
    ts: new Date().toISOString(),
    caseSlug,
    topic,
    indexEntry,
    bytes: Buffer.byteLength(content, 'utf8')
  }
  fs.appendFileSync(memoryAuditPath(argusHome), JSON.stringify(entry) + '\n')

  return `memory/${topic}.md updated (${entry.bytes} bytes${indexEntry ? ', index entry added' : ''})`
}

/** The injectable index: full _index.md minus lines that reference disabled topics. */
export function filteredIndex(argusHome: string, access: AgentAccess): string {
  const idx = readIndex(argusHome)
  if (!idx) return ''
  return idx
    .split('\n')
    .filter((l) => {
      const m = l.match(/\(([a-z0-9-]+)\.md\)/)
      return !m || topicEnabled(access, m[1])
    })
    .join('\n')
}

export function readAudit(argusHome: string, limit: number): MemoryAuditEntry[] {
  const p = memoryAuditPath(argusHome)
  if (!fs.existsSync(p)) return []
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
  return lines
    .slice(-limit)
    .reverse()
    .map((l) => JSON.parse(l) as MemoryAuditEntry)
}
