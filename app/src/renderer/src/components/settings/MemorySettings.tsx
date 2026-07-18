import { useCallback, useEffect, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { SettingsSection, SettingRow, Switch, DraftTextarea } from './settingsLayout'
import { Chip, IconBtn } from '../ui'
import { accessStore, useAccessPayload } from '../../lib/accessStore'
import { topicEnabled } from '../../../../shared/agentAccess'
import type { MemoryAuditEntry, MemoryTopicsPayload } from '../../../../shared/memoryIpc'

export function MemorySettings(): React.JSX.Element {
  const access = useAccessPayload() // keeps enablement live via access:changed
  const [payload, setPayload] = useState<MemoryTopicsPayload | null>(null)
  const [audit, setAudit] = useState<MemoryAuditEntry[]>([])
  const [editing, setEditing] = useState<string | null>(null) // topic name or '_index'
  const [draft, setDraft] = useState('')

  const refresh = useCallback(async () => {
    setPayload(await window.argus.memory.topics())
    setAudit(await window.argus.memory.audit())
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
    })()
    return () => {
      mounted = false
    }
  }, [])

  async function openEditor(name: string): Promise<void> {
    setDraft(await window.argus.memory.read(name))
    setEditing(name)
  }

  async function commit(name: string, content: string): Promise<void> {
    setPayload(await window.argus.memory.write(name, content))
    setEditing(null)
    void refresh()
  }

  async function remove(name: string): Promise<void> {
    if (!window.confirm(`Delete memory topic "${name}"? Its _index.md line is removed too.`)) return
    setPayload(await window.argus.memory.remove(name))
    void refresh()
  }

  if (!payload) return <div className="text-dim">loading…</div>

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="Memory index">
        <SettingRow
          label="_index.md"
          description="Always injected into every session. Line budget guards context size."
          stacked={editing === '_index'}
        >
          <Chip tone={payload.indexLines >= payload.capLines ? 'danger' : 'neutral'}>
            {payload.indexLines} / {payload.capLines} lines
          </Chip>
          <IconBtn aria-label="Edit _index" title="Edit" onClick={() => void openEditor('_index')}>
            <Pencil size={14} />
          </IconBtn>
        </SettingRow>
        {editing === '_index' && (
          // The editor is a bare child of the section Card, outside any SettingRow, so it
          // carries its own padding — without it the textarea sits flush against the edge.
          <div className="px-4 py-3">
            <DraftTextarea
              value={draft}
              onCommit={(v) => void commit('_index', v)}
              aria-label="edit · _index"
            />
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Topics">
        {payload.topics.length === 0 && (
          <div className="px-3 py-2 text-xs text-dim">
            No topics yet — the agent records lessons here after an RCA (via write_memory).
          </div>
        )}
        {payload.topics.map((t) => (
          <div key={t.name}>
            <SettingRow
              label={t.name}
              description={`${(t.sizeBytes / 1024).toFixed(1)} KB · last written ${t.lastWritten.slice(0, 10)}`}
            >
              <Switch
                checked={access ? topicEnabled(access.access, t.name) : t.enabled}
                onChange={(v) => void accessStore.patch({ memory: { [t.name]: v } })}
                aria-label={`enabled · ${t.name}`}
              />
              <IconBtn
                aria-label={`Edit ${t.name}`}
                title="Edit"
                onClick={() => void openEditor(t.name)}
              >
                <Pencil size={14} />
              </IconBtn>
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
              <div className="px-4 py-3">
                <DraftTextarea
                  value={draft}
                  onCommit={(v) => void commit(t.name, v)}
                  aria-label={`edit · ${t.name}`}
                />
              </div>
            )}
          </div>
        ))}
      </SettingsSection>

      <SettingsSection title="Audit — recent agent writes">
        {audit.length === 0 && (
          <div className="px-3 py-2 text-xs text-dim">No agent memory writes recorded yet.</div>
        )}
        {audit.map((a, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <span className="font-mono text-mute">{a.ts.slice(0, 16).replace('T', ' ')}</span>
            <Chip tone="defect">{a.caseSlug}</Chip>
            <span className="font-mono text-ink">{a.topic}</span>
            {a.indexEntry && <span className="truncate text-dim">— {a.indexEntry}</span>}
            <span className="ml-auto text-faint">{a.bytes} B</span>
          </div>
        ))}
      </SettingsSection>
    </div>
  )
}
