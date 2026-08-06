import fs from 'node:fs'
import path from 'node:path'
import { memoryAuditPath, memoryBackupDir, memoryDir, memoryIndexPath } from './paths'
import { topicEnabled, type AgentAccess } from '../../shared/agentAccess'
import { fillPrompt } from './prompts/fill'
import type { PromptTextSpecs } from '../../shared/promptSpec'
import { MEMORY_SCOPES, type MemoryScope } from '../../shared/memoryScope'
import { fmBlock, fmField, withFrontmatter } from '../../shared/frontmatter'

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
  /** From the file's `scope:` frontmatter. null for a pre-feature or hand-created topic, and
   *  for any value outside MEMORY_SCOPES — the UI shows no chip rather than an invented one. */
  scope: MemoryScope | null
}

export interface MemoryAuditEntry {
  ts: string
  caseSlug: string
  topic: string
  indexEntry: string | null
  bytes: number
  /** Absent = agent write (the original shape). UI-driven hygiene actions tag themselves. */
  action?: 'archive' | 'restore'
  /** Absent on entries written before the scope contract, and on archive/restore rows.
   *  Optional on purpose: readAudit must keep parsing pre-feature lines. */
  scope?: MemoryScope
}

function topicPath(argusHome: string, name: string): string {
  if (name === '_index') return memoryIndexPath(argusHome)
  if (!TOPIC_RE.test(name)) throw new Error(`Invalid memory topic name ${JSON.stringify(name)}`)
  return path.join(memoryDir(argusHome), `${name}.md`)
}

/** Matches the markdown index-link line for a given topic, anchored at line start so free
 *  text elsewhere on the line (e.g. a description mentioning another topic's filename) can't
 *  cause a false match. */
export function indexLineFor(name: string): RegExp {
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
      const full = path.join(dir, f)
      const st = fs.statSync(full)
      // Reading frontmatter is best-effort per file: one locked/unreadable topic must cost that
      // topic its chip, not take down the whole list (and every caller behind it — the Memory
      // settings page and usage-stats payload). Same shape as null-for-no-scope-frontmatter.
      let raw = ''
      try {
        const block = fmBlock(fs.readFileSync(full, 'utf8'))
        raw = block ? fmField(block.fm, 'scope') : ''
      } catch (err) {
        console.warn(`[memory] failed to read frontmatter for ${f}:`, err)
      }
      return {
        name: f.slice(0, -3),
        sizeBytes: st.size,
        lastWritten: st.mtime.toISOString(),
        scope: MEMORY_SCOPES.includes(raw as MemoryScope) ? (raw as MemoryScope) : null
      }
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
  // The backup is a recovery floor for THIS topic's previous body, not a retained artifact once
  // the topic itself is gone. Leaving it behind is invisible (no listing, no UI, no expiry) and
  // dangerous: a topic of the same name created later would inherit a stranger's leftover body
  // as its one recoverable level. force:true — an absent backup (never-replaced topic) is fine.
  // Last step on purpose: a non-ENOENT failure here (e.g. EPERM/EBUSY) must not abort the file
  // removal or the index edit above it.
  fs.rmSync(path.join(memoryBackupDir(argusHome), `${name}.md`), { force: true })
}

/** Length cap for one `_index.md` line. Referenced by both the check and its message so an
 *  overridden message can never disagree with the rule it describes. */
export const MEMORY_INDEX_ENTRY_MAX = 200

/**
 * Byte cap on the whole topic body an AGENT write may produce (~500 words). The budget was set
 * in words and expressed in bytes for enforcement: markdown syntax, absolute Windows paths and
 * inline snippets inflate byte size without moving a word counter, so a word-based gate would
 * be loosest exactly where topics get largest. Referenced by both the check and its message so
 * an overridden message can never disagree with the rule it describes. The user's own edits on
 * the Memory settings page are NOT capped.
 */
export const MEMORY_TOPIC_MAX_BYTES = 4096

/**
 * Model-facing errors thrown by the write_memory backend. Registered as `tool-feedback.*`.
 * The success return (`memory/<topic>.md updated (N bytes)`) is deliberately absent — it is a
 * write receipt, not instruction text.
 */
export const MEMORY_FEEDBACK: PromptTextSpecs = {
  'write_memory.missing-scope': {
    title: 'write_memory — no scope given',
    text: 'write_memory: scope is required and must be one of preference | environment | correction. Memory is for facts about THIS user and machine only. Knowledge a teammate would want belongs in a reference — use write_proposal(type:"reference-edit"). Detail about this case belongs in the case — use append_finding.'
  },
  'write_memory.invalid-scope': {
    title: 'write_memory — unknown scope value',
    text: 'write_memory: "{scope}" is not a valid scope — use preference | environment | correction.',
    placeholders: ['scope']
  },
  'write_memory.reserved-index': {
    title: 'write_memory — wrote to _index',
    text: 'write_memory: "_index" is a reserved topic name and cannot be written to'
  },
  'write_memory.empty-content': {
    title: 'write_memory — empty content',
    text: 'write_memory: content must not be empty'
  },
  'write_memory.index-entry-multiline': {
    title: 'write_memory — multi-line index entry',
    text: 'write_memory: index_entry must be a single line (no interior newlines)'
  },
  'write_memory.index-entry-too-long': {
    title: 'write_memory — index entry over the length cap',
    text: 'write_memory: index_entry must be at most {max} characters',
    placeholders: ['max']
  },
  'write_memory.index-full': {
    title: 'write_memory — index line cap reached',
    text: 'write_memory: _index.md is at its {max}-line cap — consolidate existing topics instead of adding new index entries',
    placeholders: ['max']
  },
  'write_memory.over-cap': {
    title: 'write_memory — topic body over the byte cap',
    text: 'write_memory: memory/{topic}.md would be {bytes} bytes, over the {max}-byte (~500 word) cap. Trim it to the personal essentials. If the bulk is durable knowledge a teammate would want, use write_proposal(type:"reference-edit"); if it is about this case, use append_finding.',
    placeholders: ['topic', 'bytes', 'max']
  }
}

/** Backend for the write_memory native tool. REPLACES the topic body (previous body → memory/.bak);
 *  maintains the index; audits. There is no append path. */
export function applyMemoryWrite(
  argusHome: string,
  caseSlug: string,
  input: { topic: string; content: string; scope: string; indexEntry?: string },
  resolve?: (id: string) => string
): string {
  /** Resolve one `tool-feedback.*` entry and fill it. No resolver = the default. */
  const fb = (key: string, vars: Record<string, string> = {}): string =>
    fillPrompt(resolve ? resolve(`tool-feedback.${key}`) : MEMORY_FEEDBACK[key].text, vars)

  const { topic, content, scope } = input
  // Runtime, not just zod: tool args cross a stringly-typed driver boundary
  // (nativeTools.ts coerces every field with String(...)), so the enum in the tool schema is
  // a hint to the model and THIS is the gate.
  if (!scope.trim()) throw new Error(fb('write_memory.missing-scope'))
  if (!MEMORY_SCOPES.includes(scope as MemoryScope)) {
    throw new Error(fb('write_memory.invalid-scope', { scope }))
  }
  if (topic === '_index') {
    throw new Error(fb('write_memory.reserved-index'))
  }
  const p = topicPath(argusHome, topic) // validates the name
  if (!content.trim()) throw new Error(fb('write_memory.empty-content'))

  const indexEntry = input.indexEntry?.trim() || null
  /** Non-null once the index is known to need a new line — written only after the cap passes. */
  let nextIndex: string | null = null
  if (indexEntry) {
    if (/[\r\n]/.test(indexEntry)) {
      throw new Error(fb('write_memory.index-entry-multiline'))
    }
    if (indexEntry.length > MEMORY_INDEX_ENTRY_MAX) {
      throw new Error(
        fb('write_memory.index-entry-too-long', { max: String(MEMORY_INDEX_ENTRY_MAX) })
      )
    }
    const idx = readIndex(argusHome)
    const lines = idx.split('\n').filter((l) => l.trim() !== '')
    const lineRe = indexLineFor(topic)
    const has = lines.some((l) => lineRe.test(l))
    if (!has && lines.length >= MEMORY_INDEX_MAX_LINES) {
      throw new Error(fb('write_memory.index-full', { max: String(MEMORY_INDEX_MAX_LINES) }))
    }
    if (!has) {
      nextIndex =
        [...lines, `- [${topic}](${topic}.md) — ${stripTopicEcho(topic, indexEntry)}`].join('\n') +
        '\n'
    }
  }

  // The whole body about to hit disk, stamp included. The cap is measured on THIS — the same
  // discipline writeUserSkill uses when it re-validates post-stamp — so no composition of
  // stamp-plus-content can produce a file the gate would have rejected.
  const body = withFrontmatter(`${content.trim()}\n`, { scope })
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MEMORY_TOPIC_MAX_BYTES) {
    throw new Error(
      fb('write_memory.over-cap', {
        topic,
        bytes: String(bytes),
        max: String(MEMORY_TOPIC_MAX_BYTES)
      })
    )
  }

  // Nothing above this line touches disk: every rejection leaves the topic file, the backup,
  // the index and the audit exactly as they were.
  fs.mkdirSync(memoryDir(argusHome), { recursive: true })
  if (nextIndex !== null) fs.writeFileSync(memoryIndexPath(argusHome), nextIndex)
  // Replace is lossy if a model rewrites without reading first. One level, no rotation, no UI —
  // a floor under that failure, not a version history.
  if (fs.existsSync(p)) {
    fs.mkdirSync(memoryBackupDir(argusHome), { recursive: true })
    fs.copyFileSync(p, path.join(memoryBackupDir(argusHome), `${topic}.md`))
  }
  fs.writeFileSync(p, body)

  const entry: MemoryAuditEntry = {
    ts: new Date().toISOString(),
    caseSlug,
    topic,
    indexEntry,
    bytes,
    scope: scope as MemoryScope
  }
  fs.appendFileSync(memoryAuditPath(argusHome), JSON.stringify(entry) + '\n')

  return `memory/${topic}.md updated (${bytes} bytes${indexEntry ? ', index entry added' : ''})`
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
