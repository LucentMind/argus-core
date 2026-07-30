import { parseAuthorship, authorName, type Origin } from '../../../../shared/authorship'

/** Prose, not the raw token — `origin: proposal` means an agent drafted it and a human kept it. */
const ORIGIN_LABEL: Record<Origin, string> = {
  authored: 'written by hand',
  proposal: 'from an agent proposal',
  fork: 'forked'
}

/** The audit trail, rendered from the raw file the viewer already loaded — no IPC involved. */
export function AuthorshipStrip({ raw }: { raw: string }): React.JSX.Element | null {
  const { author, origin, contributors } = parseAuthorship(raw)
  const name = authorName(author)
  if (!name) return null
  return (
    <div className="border-b border-hair px-4 py-2 text-xs text-dim">
      <div>
        by <span className="text-ink">{name}</span>
        {origin ? ` · ${ORIGIN_LABEL[origin]}` : ''}
      </div>
      {contributors.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-faint">
          {contributors.map((c) => (
            <li key={c.email}>
              {c.name || c.email} · {c.date}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
