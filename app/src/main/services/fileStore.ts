import fs from 'node:fs'
import path from 'node:path'

/**
 * Sparse watched JSON config file (settings.json, later mcp-servers.json).
 * - load tolerates a UTF-8 BOM and a missing file (Windows editors add BOMs).
 * - write is atomic (temp + rename) and BOM-free.
 * - watch observes the *directory* (a file watch dies on atomic rename) and
 *   suppresses self-writes by content comparison, debounced 200 ms.
 */
export class JsonFileStore {
  private lastWritten: string | null = null
  private watcher: fs.FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null
  private listeners = new Set<() => void>()

  constructor(private filePath: string) {}

  load(): { data: unknown; error: string | null } {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, error: null }
      return { data: {}, error: (err as Error).message }
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    try {
      return { data: JSON.parse(raw), error: null }
    } catch (err) {
      return { data: {}, error: (err as Error).message }
    }
  }

  write(obj: unknown): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const text = JSON.stringify(obj, null, 2) + '\n'
    const tmp = this.filePath + '.tmp'
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, this.filePath)
    this.lastWritten = text
  }

  watch(cb: () => void): () => void {
    this.listeners.add(cb)
    if (!this.watcher) {
      const dir = path.dirname(this.filePath)
      fs.mkdirSync(dir, { recursive: true })
      const base = path.basename(this.filePath)
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename !== base) return
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => {
          let now = ''
          try {
            now = fs.readFileSync(this.filePath, 'utf8')
          } catch {
            /* deleted mid-write — treat as changed */
          }
          if (now === this.lastWritten) return
          this.lastWritten = now
          for (const l of this.listeners) l()
        }, 200)
      })
    }
    return () => this.listeners.delete(cb)
  }

  close(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.watcher?.close()
    this.watcher = null
    this.listeners.clear()
  }
}
