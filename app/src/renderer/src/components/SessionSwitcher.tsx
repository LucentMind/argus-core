import { useEffect, useState } from 'react'
import type { SessionSummary } from '../../../shared/types'

function displayTitle(s: { id: number; title: string }): string {
  return s.title || `Chat ${s.id}`
}

// Coarse relative-time label for the session list — good enough for "which
// chat did I just touch," not meant to be a precise clock.
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMin = Math.round((Date.now() - then) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return `${Math.round(diffHr / 24)}d ago`
}

export function SessionSwitcher({
  slug,
  sessionId,
  onSwitch
}: {
  slug: string
  sessionId: number
  onSwitch: (id: number) => void
  onJumpToTurn: (sessionId: number, turnId: number | null) => void
}): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // the trigger needs the active title even before the popup is ever opened
  useEffect(() => {
    void window.argus.sessions.list(slug).then(setSessions)
  }, [slug])

  useEffect(() => {
    if (!open) return
    void window.argus.sessions.list(slug).then(setSessions)
  }, [open, slug])

  const active = sessions.find((s) => s.id === sessionId)
  const activeTitle = active ? displayTitle(active) : `Chat ${sessionId}`
  const sorted = [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )

  async function createChat(): Promise<void> {
    const created = await window.argus.sessions.create(slug)
    setOpen(false)
    onSwitch(created.id)
  }

  function startRename(s: SessionSummary): void {
    setRenamingId(s.id)
    setRenameValue(displayTitle(s))
  }

  async function commitRename(id: number): Promise<void> {
    const title = renameValue.trim()
    setRenamingId(null)
    if (!title) return
    await window.argus.sessions.rename(id, title)
    void window.argus.sessions.list(slug).then(setSessions)
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <button
          type="button"
          aria-label={activeTitle}
          className="flex items-center gap-1 rounded-r2 px-2 py-1 text-xs text-ink transition-colors hover:bg-hair"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="max-w-48 truncate">{activeTitle}</span>
          <span aria-hidden="true">⌄</span>
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div
              role="menu"
              aria-label="Sessions"
              className="absolute left-0 top-full z-20 mt-1 w-72 rounded-r2 border border-hair bg-overlay p-1 shadow-lg"
            >
              {sorted.map((s) => {
                const title = displayTitle(s)
                const isRenaming = renamingId === s.id
                return (
                  <div key={s.id} className="flex items-center gap-1 rounded-r1 px-1 hover:bg-hi">
                    {isRenaming ? (
                      <input
                        autoFocus
                        aria-label={`Rename ${title}`}
                        className="flex-1 rounded-r1 bg-panel px-1.5 py-1 text-xs text-ink outline-none"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(s.id)
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="min-w-0 flex-1 rounded-r1 px-1 py-1.5 text-left"
                        onClick={() => {
                          setOpen(false)
                          onSwitch(s.id)
                        }}
                      >
                        <span className="block truncate text-xs text-ink">{title}</span>
                        <span className="block truncate text-[10.5px] text-mute">
                          {relativeTime(s.updatedAt)} · {s.turnCount} turns
                        </span>
                      </button>
                    )}
                    {!isRenaming && (
                      <button
                        type="button"
                        aria-label={`Rename ${title}`}
                        title="Rename"
                        className="shrink-0 rounded-r1 px-1.5 py-1 text-mute transition-colors hover:bg-hair hover:text-ink"
                        onClick={() => startRename(s)}
                      >
                        ✎
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
      <button
        type="button"
        aria-label="New chat"
        title="New chat"
        className="flex items-center gap-1 rounded-r2 px-2 py-1 text-xs text-dim transition-colors hover:bg-hair hover:text-ink"
        onClick={() => void createChat()}
      >
        <span aria-hidden="true">＋</span>
        <span>New chat</span>
      </button>
      <input
        disabled
        aria-label="Search chats"
        placeholder="Search chats"
        className="w-40 rounded-r2 border border-hair bg-panel px-2 py-1 text-xs text-mute placeholder:text-mute disabled:opacity-50"
      />
    </div>
  )
}
