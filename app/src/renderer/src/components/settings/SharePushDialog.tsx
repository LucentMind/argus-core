import { useEffect, useState, useCallback } from 'react'
import { X, ExternalLink } from 'lucide-react'
import { Btn, Chip, IconBtn } from '../ui'
import type { PushReceipt } from '../../../../shared/hivemind'
import type { SourceControlStatus } from '../../../../shared/sourcecontrol'

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

/**
 * Shared readiness + receipt state for the in-place Share buttons (Tier 2).
 * The Promise.resolve wrappers turn a missing preload namespace (tests that
 * don't mock hivemind/sourceControl) into "share disabled", not a crash.
 */
export function useSharePush(): {
  shareReady: boolean
  shareTip: string
  pushes: Record<string, PushReceipt>
  refresh: () => void
} {
  const [gh, setGh] = useState<SourceControlStatus | null>(null)
  const [repoSet, setRepoSet] = useState(false)
  const [pushes, setPushes] = useState<Record<string, PushReceipt>>({})

  const refresh = useCallback(() => {
    void Promise.resolve()
      .then(() => window.argus.hivemind.get())
      .then((p) => {
        setRepoSet(p.repo.trim() !== '')
        setPushes(p.pushes)
      })
      .catch(() => undefined)
    void Promise.resolve()
      .then(() => window.argus.sourceControl.status())
      .then(setGh)
      .catch(() => undefined)
  }, [])

  useEffect(() => refresh(), [refresh])

  const shareReady = repoSet && gh !== null && gh.installed && gh.authenticated
  return {
    shareReady,
    shareTip: shareReady
      ? 'Share to HiveMind…'
      : 'Sharing needs a configured HiveMind repo and an authenticated GitHub CLI — see Settings → HiveMind.',
    pushes,
    refresh
  }
}

/** "PR ↗" chip linking the last successful HiveMind push for one asset. */
export function PushReceiptChip({
  name,
  receipt
}: {
  name: string
  receipt: PushReceipt
}): React.JSX.Element {
  return (
    <button
      aria-label={`Open PR · ${name}`}
      title={`${receipt.prUrl} — pushed ${receipt.pushedAt.slice(0, 10)}`}
      className="inline-flex items-center gap-1 rounded-full border border-hair px-2 py-0.5 text-xs text-dim transition-colors hover:text-signal"
      onClick={() => void window.argus.openExternal(receipt.prUrl)}
    >
      PR
      <ExternalLink size={10} aria-hidden="true" />
    </button>
  )
}
