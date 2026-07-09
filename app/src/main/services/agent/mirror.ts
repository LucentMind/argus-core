import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '../../../shared/agent-events'
import type { SessionMirrorLike } from './session'

export class SessionMirror implements SessionMirrorLike {
  private buffer: string[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private db: DatabaseSync,
    private filePath: string,
    private ids: { caseId: number; sessionId: number }
  ) {
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
    this.db
      .prepare(`INSERT INTO messages_fts (content, case_id, session_id, turn_id, role) VALUES (?, ?, ?, ?, ?)`)
      .run(content, this.ids.caseId, this.ids.sessionId, turnId, role)
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
