import { useEffect, useState } from 'react'
import { SettingsSection } from './settingsLayout'
import { Btn, Chip, SectionLabel } from '../ui'
import { diffLines } from '../../lib/lineDiff'
import { blurOnEscape } from '../../lib/escapeLayer'
import { MessageView } from '../MessageView'
import { PROPOSAL_TYPE_LABELS } from '../../../../shared/proposals'
import type { ProposalRecord, ProposalsPayload } from '../../../../shared/proposals'

const noop = (): void => undefined

const KIND_PREFIX = { same: '  ', add: '+ ', del: '- ' } as const
const KIND_CLASS = { same: 'text-dim', add: 'text-signal', del: 'text-danger' } as const

function ProposalDiff({ p }: { p: ProposalRecord }): React.JSX.Element {
  const lines = diffLines(p.current ?? '', p.content)
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs">
      {lines.map((l, i) => (
        <div key={i} className={KIND_CLASS[l.kind]}>
          {KIND_PREFIX[l.kind]}
          {l.text}
        </div>
      ))}
    </pre>
  )
}

export function ProposalsTab({
  onCountChange
}: {
  onCountChange: (n: number) => void
}): React.JSX.Element {
  const [payload, setPayload] = useState<ProposalsPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('all')
  const [editing, setEditing] = useState<Record<string, string>>({})

  function apply(p: ProposalsPayload): void {
    setPayload(p)
    onCountChange(p.proposals.length)
  }

  useEffect(() => {
    let mounted = true
    void window.argus.proposals
      .list()
      .then((p) => {
        if (mounted) {
          setPayload(p)
          onCountChange(p.proposals.length)
        }
      })
      .catch((e) => {
        if (mounted) {
          setPayload({ proposals: [] })
          setError(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on mount
  }, [])

  async function act(fn: () => Promise<ProposalsPayload>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      apply(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!payload) return <div className="text-dim">loading…</div>

  const typesPresent = Array.from(new Set(payload.proposals.map((p) => p.type)))
  const filtered =
    filter === 'all' ? payload.proposals : payload.proposals.filter((p) => p.type === filter)
  const sorted = [...filtered].sort(
    (a, b) => a.caseSlug.localeCompare(b.caseSlug) || b.date.localeCompare(a.date)
  )

  function toggleEdit(p: ProposalRecord): void {
    setEditing((prev) => {
      const next = { ...prev }
      if (p.file in next) {
        delete next[p.file]
      } else {
        next[p.file] = p.content
      }
      return next
    })
  }

  let lastCaseSlug: string | null = null

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
        >
          {error}
        </div>
      )}
      <div className="flex items-center gap-2 px-1">
        <label className="text-xs text-mute" htmlFor="proposals-type-filter">
          Type
        </label>
        <select
          id="proposals-type-filter"
          aria-label="Filter by type"
          className="h-7 rounded-r2 border border-hair bg-overlay px-2 text-xs text-ink"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={blurOnEscape}
        >
          <option value="all">all</option>
          {typesPresent.map((t) => (
            <option key={t} value={t}>
              {PROPOSAL_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      {payload.proposals.length === 0 ? (
        <div className="px-1 py-2 text-sm text-dim">
          No pending proposals — the agent drafts them via /contribute-back (write_proposal).
        </div>
      ) : (
        sorted.map((p) => {
          const showCaseHeader = p.caseSlug !== lastCaseSlug
          lastCaseSlug = p.caseSlug
          const isEditing = p.file in editing
          const isMarkdown = p.type === 'memory-append' || p.type === 'case-summary'
          return (
            <div key={p.file} className="flex flex-col gap-2">
              {showCaseHeader && <SectionLabel>Case: {p.caseSlug}</SectionLabel>}
              <SettingsSection title={p.title}>
                <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                  <Chip tone="neutral">{PROPOSAL_TYPE_LABELS[p.type]}</Chip>
                  {p.type !== 'case-summary' && <Chip tone="neutral">→ {p.target}</Chip>}
                  <span className="text-xs text-mute">{new Date(p.date).toLocaleString()}</span>
                  {p.current === null && <Chip tone="review">new file</Chip>}
                  {p.previouslyReviewed && <Chip tone="review">previously reviewed</Chip>}
                </div>
                {isEditing ? (
                  <textarea
                    aria-label="Edit proposal content"
                    className="max-h-64 w-full overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs"
                    rows={8}
                    value={editing[p.file]}
                    onChange={(e) => setEditing((prev) => ({ ...prev, [p.file]: e.target.value }))}
                  />
                ) : isMarkdown ? (
                  <div className="px-4 py-3">
                    <MessageView markdown={p.content} onCite={noop} />
                  </div>
                ) : (
                  <ProposalDiff p={p} />
                )}
                <div className="flex items-center gap-2 px-4 py-3">
                  <Btn
                    variant="primary"
                    aria-label={`Accept ${p.title}`}
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        isEditing
                          ? window.argus.proposals.accept(p.file, editing[p.file])
                          : window.argus.proposals.accept(p.file)
                      )
                    }
                  >
                    Accept
                  </Btn>
                  <Btn
                    variant="danger"
                    aria-label={`Reject ${p.title}`}
                    disabled={busy}
                    onClick={() => void act(() => window.argus.proposals.reject(p.file))}
                  >
                    Reject
                  </Btn>
                  <Btn
                    variant="outline"
                    aria-label={`Edit ${p.title}`}
                    onClick={() => toggleEdit(p)}
                  >
                    Edit
                  </Btn>
                </div>
              </SettingsSection>
            </div>
          )
        })
      )}
    </div>
  )
}
