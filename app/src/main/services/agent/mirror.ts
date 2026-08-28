import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '../../../shared/agent-events'
import type { SessionMirrorLike } from './session'
import { insertMessageFts } from '../ftsIndex'
import { assertCaseWritable } from '../caseFreeze'

/** Replay a single session's mirror JSONL file (transcript history) in write order. */
export function readSessionEvents(caseDir: string, sessionId: number): AgentEvent[] {
  // defense in depth: sessionId ends up in a filesystem path below, so a
  // non-integer (e.g. a path-traversal payload smuggled through IPC) must
  // never reach fs.* — reject before any fs call.
  if (!Number.isInteger(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  const file = path.join(caseDir, 'sessions', `${sessionId}.jsonl`)
  if (!fs.existsSync(file)) return []
  const events: AgentEvent[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as AgentEvent)
    } catch {
      // skip corrupt lines (e.g. torn write on crash)
    }
  }
  return events
}

export class SessionMirror implements SessionMirrorLike {
  private buffer: string[] = []
  private timer: NodeJS.Timeout | null = null

  /**
   * `caseSlug` is required, not derived from `filePath`, because it is what the freeze
   * registry is keyed on — and constructing a mirror is the act this guard refuses.
   *
   * Every transcript writer in the app acquires its mirror here: `index.ts` builds ONE
   * `mirrorFactory` and hands it to both `AgentService` (foreground chat, registry.ts) and
   * `runBackgroundTurn` (routines, background.ts). Guarding session CREATION alone would miss
   * the case where an existing session is resumed inside the archive window — no new sessions
   * row, but the constructor below `mkdirSync`s `sessions/` back into existence and the
   * appends land in a tree the archive is about to delete.
   */
  constructor(
    private db: DatabaseSync,
    private filePath: string,
    private ids: { caseId: number; sessionId: number; caseSlug: string }
  ) {
    assertCaseWritable(db, ids.caseSlug)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  }

  append(e: AgentEvent): void {
    this.buffer.push(JSON.stringify(e))
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 250)
    }
  }

  private flush(): void {
    this.timer = null
    if (this.buffer.length === 0) return
    const chunk = this.buffer.splice(0).join('\n') + '\n'
    // write-behind: failures surface as a warning, never block the stream
    fs.appendFile(this.filePath, chunk, (err) => {
      if (err) console.warn(`[mirror] append failed: ${err.message}`)
    })
  }

  indexText(role: string, content: string, turnId: number | null): void {
    if (!content.trim()) return
    insertMessageFts(this.db, content, this.ids.caseId, this.ids.sessionId, turnId, role)
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.buffer.length > 0) {
      try {
        fs.appendFileSync(this.filePath, this.buffer.splice(0).join('\n') + '\n')
      } catch (err) {
        console.warn(`[mirror] final flush failed: ${(err as Error).message}`)
      }
    }
  }
}
