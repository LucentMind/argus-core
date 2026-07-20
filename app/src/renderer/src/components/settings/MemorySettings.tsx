import { useCallback, useEffect, useState } from 'react'
import { Archive, ArchiveRestore, Check, Pencil, Trash2 } from 'lucide-react'
import { SettingsSection, SettingRow, Switch, TEXTAREA_FIELD } from './settingsLayout'
import { Btn, Chip, IconBtn } from '../ui'
import { accessStore, useAccessPayload } from '../../lib/accessStore'
import { confirm } from '../../lib/confirmStore'
import { topicEnabled } from '../../../../shared/agentAccess'
import type { MemoryAuditEntry, MemoryTopicsPayload } from '../../../../shared/memoryIpc'
import type { UsageStatsPayload, MemoryUsageRow } from '../../../../shared/observability'

/**
 * A readable summary for an audit row. The audit stores two `indexEntry` shapes: an agent
 * write keeps the bare description, while archive/restore save the whole
 * `- [topic](topic.md) — description` index line (load-bearing — restore rebuilds _index.md
 * from it verbatim). Rendered raw, the long slug repeats up to four times per row, so strip
 * the markdown-link boilerplate and any leading echo of the topic name, keeping the stored
 * value untouched. Display-side mirror of main's stripTopicEcho (services/memory.ts).
 */
function auditSummary(topic: string, indexEntry: string): string {
  const afterLink = indexEntry.replace(/^-?\s*\[[^\]]*\]\([^)]*\)\s*[—–\-:]*\s*/, '').trim()
  const slug = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-\\s]')
  const deEchoed = afterLink.replace(new RegExp(`^${slug}\\s*[—–\\-:]+\\s*`, 'i'), '').trim()
  // never collapse to nothing — a slightly redundant line beats a blank one
  return deEchoed || afterLink || indexEntry.trim()
}

/** ` · N recalls[, last YYYY-MM-DD]` — appended to a topic row's description. */
function usageLine(u: MemoryUsageRow | undefined): string {
  if (!u) return ''
  const recalls = u.recallCount === 0 ? 'never recalled' : `${u.recallCount} recalls`
  const last = u.lastRecalledAt ? `, last ${u.lastRecalledAt.slice(0, 10)}` : ''
  return ` · ${recalls}${last}`
}

/**
 * Pencil while closed, check while open — one affordance that both opens and commits, which
 * is what a single button on the row implies. Declared at module scope (not nested in
 * MemorySettings) so it isn't recreated per render: `react-hooks/static-components`, and for
 * {@link MemoryEditor} it would also remount the textarea and drop the caret on every
 * keystroke.
 */
function EditToggle({
  name,
  open,
  onOpen,
  onSave
}: {
  name: string
  open: boolean
  onOpen: () => void
  onSave: () => void
}): React.JSX.Element {
  return (
    <IconBtn
      aria-label={open ? `Save ${name}` : `Edit ${name}`}
      title={open ? 'Save' : 'Edit'}
      className={open ? 'text-signal' : undefined}
      onClick={open ? onSave : onOpen}
    >
      {open ? <Check size={14} /> : <Pencil size={14} />}
    </IconBtn>
  )
}

/**
 * Editor body: a plain textarea over the caller's draft, so Save is the only writer.
 * Deliberately NOT DraftTextarea, which commits on blur — that would fire on the way to
 * clicking Save and write twice, and would also persist a draft the user meant to abandon.
 */
function MemoryEditor({
  name,
  value,
  onChange,
  onSave,
  onCancel
}: {
  name: string
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    // A bare child of the section Card, outside any SettingRow, so it carries its own
    // padding — without it the textarea sits flush against the edge.
    <div className="flex flex-col gap-2 px-4 py-3">
      <textarea
        autoFocus
        aria-label={`edit · ${name}`}
        className={TEXTAREA_FIELD}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="flex items-center gap-2">
        <Btn variant="primary" onClick={onSave}>
          Save
        </Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
        <span className="text-xs text-mute">Esc cancels</span>
      </div>
    </div>
  )
}

export function MemorySettings(): React.JSX.Element {
  const access = useAccessPayload() // keeps enablement live via access:changed
  const [payload, setPayload] = useState<MemoryTopicsPayload | null>(null)
  const [audit, setAudit] = useState<MemoryAuditEntry[]>([])
  const [usage, setUsage] = useState<UsageStatsPayload | null>(null)
  const [editing, setEditing] = useState<string | null>(null) // topic name or '_index'
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setPayload(await window.argus.memory.topics())
    setAudit(await window.argus.memory.audit())
    setUsage(await window.argus.usage.stats().catch(() => null))
  }, [])

  useEffect(() => {
    let mounted = true
    void (async () => {
      const topics = await window.argus.memory.topics()
      if (!mounted) return
      setPayload(topics)
      const entries = await window.argus.memory.audit()
      if (!mounted) return
      setAudit(entries)
      const stats = await window.argus.usage.stats().catch(() => null)
      if (!mounted) return
      setUsage(stats)
    })()
    return () => {
      mounted = false
    }
  }, [])

  async function openEditor(name: string): Promise<void> {
    setDraft(await window.argus.memory.read(name))
    setEditing(name)
  }

  async function save(name: string): Promise<void> {
    setPayload(await window.argus.memory.write(name, draft))
    setEditing(null)
    void refresh()
  }

  /** Close without writing. Bound to Escape and to a second click on the toggle when
   *  nothing was typed — an editor you can only leave by saving is a trap. */
  function cancel(): void {
    setEditing(null)
    setDraft('')
  }

  async function remove(name: string): Promise<void> {
    if (
      !(await confirm({
        title: `Delete memory topic "${name}"?`,
        message: 'Its _index.md line is removed too. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true
      }))
    )
      return
    setPayload(await window.argus.memory.remove(name))
    void refresh()
  }

  async function archive(name: string): Promise<void> {
    if (
      !(await confirm({
        title: `Archive memory topic "${name}"?`,
        message: 'It stops being injected/recallable; restore any time from the Archived section.',
        confirmLabel: 'Archive'
      }))
    )
      return
    setError(null)
    try {
      setPayload(await window.argus.memory.archive(name))
      void refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function restore(name: string): Promise<void> {
    setError(null)
    try {
      setPayload(await window.argus.memory.restore(name))
      void refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!payload) return <div className="text-dim">loading…</div>

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="rounded-r2 border border-danger/30 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}
      <SettingsSection title="Memory index">
        <SettingRow
          label="_index.md"
          description="Always injected into every session. Line budget guards context size."
          stacked={editing === '_index'}
        >
          <Chip tone={payload.indexLines >= payload.capLines ? 'danger' : 'neutral'}>
            {payload.indexLines} / {payload.capLines} lines
          </Chip>
          <EditToggle
            name="_index"
            open={editing === '_index'}
            onOpen={() => void openEditor('_index')}
            onSave={() => void save('_index')}
          />
        </SettingRow>
        {editing === '_index' && (
          <MemoryEditor
            name="_index"
            value={draft}
            onChange={setDraft}
            onSave={() => void save('_index')}
            onCancel={cancel}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Topics">
        {payload.topics.length === 0 && (
          <div className="px-3 py-2 text-xs text-dim">
            No topics yet — the agent records lessons here after an RCA (via write_memory).
          </div>
        )}
        {payload.topics.map((t) => {
          const u = usage?.memory.find((m) => m.topic === t.name)
          return (
            <div key={t.name}>
              <SettingRow
                label={t.name}
                description={`${(t.sizeBytes / 1024).toFixed(1)} KB · last written ${t.lastWritten.slice(0, 10)}${usageLine(u)}`}
              >
                {u?.staleCandidate && (
                  <Chip tone="review">
                    <span
                      title={`No recall in ${usage!.hygiene.staleDays}+ days and fewer than ${usage!.hygiene.minRecalls} recalls since ${usage!.hygiene.trackingStartedAt.slice(0, 10)} — candidate to archive`}
                    >
                      stale
                    </span>
                  </Chip>
                )}
                <IconBtn
                  aria-label={`Archive ${t.name}`}
                  title="Archive (recoverable)"
                  onClick={() => void archive(t.name)}
                >
                  <Archive size={14} />
                </IconBtn>
                <Switch
                  checked={access ? topicEnabled(access.access, t.name) : t.enabled}
                  onChange={(v) => void accessStore.patch({ memory: { [t.name]: v } })}
                  aria-label={`enabled · ${t.name}`}
                />
                <EditToggle
                  name={t.name}
                  open={editing === t.name}
                  onOpen={() => void openEditor(t.name)}
                  onSave={() => void save(t.name)}
                />
                <IconBtn
                  aria-label={`Delete ${t.name}`}
                  title="Delete"
                  className="hover:text-danger"
                  onClick={() => void remove(t.name)}
                >
                  <Trash2 size={14} />
                </IconBtn>
              </SettingRow>
              {editing === t.name && (
                <MemoryEditor
                  name={t.name}
                  value={draft}
                  onChange={setDraft}
                  onSave={() => void save(t.name)}
                  onCancel={cancel}
                />
              )}
            </div>
          )
        })}
      </SettingsSection>

      {usage && usage.archived.length > 0 && (
        <SettingsSection title="Archived topics">
          {usage.archived.map((a) => (
            <SettingRow
              key={a.topic}
              label={a.topic}
              description={`${(a.sizeBytes / 1024).toFixed(1)} KB${a.archivedAt ? ` · archived ${a.archivedAt.slice(0, 10)}` : ''}`}
            >
              <Btn aria-label={`Restore ${a.topic}`} onClick={() => void restore(a.topic)}>
                <ArchiveRestore size={14} /> Restore
              </Btn>
            </SettingRow>
          ))}
        </SettingsSection>
      )}

      <SettingsSection title="Audit — recent memory activity">
        {audit.length === 0 && (
          <div className="px-3 py-2 text-xs text-dim">No memory activity recorded yet.</div>
        )}
        {audit.map((a, i) => {
          const summary = a.indexEntry ? auditSummary(a.topic, a.indexEntry) : null
          return (
            <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="font-mono text-mute">{a.ts.slice(0, 16).replace('T', ' ')}</span>
              <Chip tone="defect">{a.caseSlug}</Chip>
              {a.action && (
                <Chip tone={a.action === 'restore' ? 'signal' : 'neutral'}>
                  {a.action === 'restore' ? 'restored' : 'archived'}
                </Chip>
              )}
              <span className="font-mono text-ink">{a.topic}</span>
              {summary && <span className="truncate text-dim">— {summary}</span>}
              {/* bytes are meaningful only for content writes; archive/restore carry none */}
              {!a.action && <span className="ml-auto text-faint">{a.bytes} B</span>}
            </div>
          )
        })}
      </SettingsSection>
    </div>
  )
}
