import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Btn, Chip, IconBtn } from '../ui'

/**
 * Preview → PR-title → push flow for sharing one user-tier asset to the
 * HiveMind. Used inline under a pushable row (HivemindSettings) and under a
 * just-accepted proposal (ProposalsPage) — same IPC as the original Share tab.
 */
export function SharePushDialog({
  kind,
  name,
  onClose,
  onBusyChange
}: {
  kind: 'skill' | 'reference'
  name: string
  onClose: () => void
  /** Fires while a push is in flight so the host can gate actions that would unmount the dialog. */
  onBusyChange?: (busy: boolean) => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<string | null>(null)
  const [title, setTitle] = useState(`Add ${name}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [previewAttempt, setPreviewAttempt] = useState(0)

  useEffect(() => {
    let mounted = true
    window.argus.hivemind
      .pushPreview(kind, name)
      .then((p) => mounted && setPreview(p))
      .catch((e) => mounted && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      mounted = false
    }
  }, [kind, name, previewAttempt])

  // If the host unmounts the dialog mid-push anyway (e.g. tab switch), don't leave it gated.
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])

  async function doPush(): Promise<void> {
    if (busy) return
    setBusy(true)
    onBusyChange?.(true)
    setError(null)
    try {
      const r = await window.argus.hivemind.push(kind, name, title)
      if (r.ok) setPrUrl(r.prUrl)
      else setError(r.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  if (prUrl) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm">
        <Chip tone="signal">PR opened</Chip>
        <Btn variant="ghost" onClick={() => void window.argus.openExternal(prUrl)}>
          {prUrl}
        </Btn>
        <Btn variant="outline" onClick={onClose}>
          Done
        </Btn>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {error && (
        <div
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
        >
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-xs text-dim">PR title</span>
        <input
          aria-label="PR title"
          className="h-7 min-w-0 flex-1 rounded-r2 border border-hair bg-overlay px-2 text-xs text-ink"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-dim">
        {preview ?? 'loading…'}
      </pre>
      <div className="flex items-center gap-2">
        <Btn
          variant="primary"
          disabled={busy || preview === null || !title.trim()}
          onClick={() => void doPush()}
        >
          {busy ? 'Pushing…' : 'Open pull request'}
        </Btn>
        {preview === null && error !== null && (
          <Btn
            variant="outline"
            onClick={() => {
              setError(null)
              setPreviewAttempt((a) => a + 1)
            }}
          >
            Retry preview
          </Btn>
        )}
        <IconBtn aria-label="Cancel" title="Cancel" onClick={onClose}>
          <X size={14} />
        </IconBtn>
      </div>
    </div>
  )
}
