import { useEffect, useState } from 'react'
import { ModalShell } from '../ModalShell'
import { Btn, Checkbox } from '../ui'
import type { SkillImportCandidate } from '../../../../shared/memoryIpc'

/**
 * Scan the user's real Claude Code skill directories (global `~/.claude/skills`, and optionally a
 * project folder's `.claude/skills`) and let them pick which ones to copy into their Argus
 * Library — the "transfer skills from Claude" flow, so users don't have to hand-copy SKILL.md
 * files. Opened from LibraryPage's "New" menu.
 */
export function ImportSkillsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [items, setItems] = useState<SkillImportCandidate[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [scanning, setScanning] = useState(true)
  const [browsing, setBrowsing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failures, setFailures] = useState<Record<string, string>>({})

  useEffect(() => {
    let mounted = true
    window.argus.skills
      .scanImport({ kind: 'global' })
      .then((found) => {
        if (mounted) setItems(found)
      })
      .catch((err) => {
        if (mounted) setError((err as Error).message)
      })
      .finally(() => {
        if (mounted) setScanning(false)
      })
    return () => {
      mounted = false
    }
  }, [])

  function mergeFound(found: SkillImportCandidate[]): void {
    setItems((prev) => {
      const seen = new Set(prev.map((i) => i.sourceDir))
      return [...prev, ...found.filter((i) => !seen.has(i.sourceDir))]
    })
  }

  async function browseProject(): Promise<void> {
    setError(null)
    setBrowsing(true)
    try {
      const dir = await window.argus.workspaces.pick()
      if (!dir) return
      mergeFound(await window.argus.skills.scanImport({ kind: 'project', dir }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBrowsing(false)
    }
  }

  function toggle(sourceDir: string, checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(sourceDir)
      else next.delete(sourceDir)
      return next
    })
  }

  const importable = items.filter((i) => i.status === 'importable')
  const allSelected = importable.length > 0 && importable.every((i) => selected.has(i.sourceDir))
  const busy = scanning || browsing || applying
  // The initial mount-effect scan already guards its setState with a `mounted` flag, so a slow
  // scan is safe to dismiss through — only an in-flight browse or apply (whose IPC calls are not
  // similarly guarded) needs to block Escape/backdrop/X/Cancel.
  const closeBusy = browsing || applying

  async function confirmImport(): Promise<void> {
    const toImport = items
      .filter((i) => selected.has(i.sourceDir))
      .map((i) => ({ name: i.name, sourceDir: i.sourceDir }))
    if (toImport.length === 0) return
    setApplying(true)
    setError(null)
    setFailures({})
    try {
      const { results } = await window.argus.skills.applyImport(toImport)
      const failed = toImport
        .map((item, idx) => ({
          item,
          result: results[idx] ?? { name: item.name, ok: false, error: 'No result returned.' }
        }))
        .filter(({ result }) => !result.ok)
      if (failed.length > 0) {
        setFailures(
          Object.fromEntries(
            failed.map(({ item, result }) => [item.sourceDir, result.error ?? 'Import failed.'])
          )
        )
        setSelected(new Set(failed.map(({ item }) => item.sourceDir)))
      } else {
        onClose()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setApplying(false)
    }
  }

  const title = 'Import skills from Claude'
  return (
    <ModalShell
      title={title}
      ariaLabel={title}
      onClose={closeBusy ? () => {} : onClose}
      className="flex max-h-[80vh] w-[32rem] flex-col"
    >
      <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4">
        <p className="text-xs leading-relaxed text-dim">
          Skills found in your Claude directories. Pick which ones to copy into your Argus Library.
        </p>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <Btn variant="outline" onClick={() => void browseProject()} disabled={busy}>
          {browsing ? 'Scanning…' : 'Browse project folder…'}
        </Btn>
        {scanning ? (
          <div className="text-xs text-dim">Scanning your Claude skills…</div>
        ) : items.length === 0 ? (
          <div className="text-xs text-faint">No skills found.</div>
        ) : (
          <>
            <Checkbox
              checked={allSelected}
              onChange={(v) =>
                setSelected(v ? new Set(importable.map((i) => i.sourceDir)) : new Set())
              }
              label="Select all importable"
              aria-label="Select all importable"
            />
            <div className="flex-1 overflow-y-auto rounded-r2 border border-hair">
              {items.map((i) => (
                <div
                  key={i.sourceDir}
                  className="flex items-start gap-2 border-b border-hair px-2 py-1.5 last:border-b-0"
                >
                  {i.status === 'importable' ? (
                    <Checkbox
                      checked={selected.has(i.sourceDir)}
                      onChange={(v) => toggle(i.sourceDir, v)}
                      label=""
                      aria-label={`Import · ${i.name}`}
                    />
                  ) : (
                    <span
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-r1 border border-hair2"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-ink">{i.name}</div>
                    {i.status !== 'importable' && (
                      <div className="text-xs text-faint">{i.reason}</div>
                    )}
                    {i.status === 'importable' && i.description && (
                      <div className="text-xs text-dim">{i.description}</div>
                    )}
                    {failures[i.sourceDir] && (
                      <div className="text-xs text-danger">{failures[i.sourceDir]}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose} disabled={closeBusy}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            onClick={() => void confirmImport()}
            disabled={applying || selected.size === 0}
          >
            {applying ? 'Importing…' : `Import${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </Btn>
        </div>
      </div>
    </ModalShell>
  )
}
