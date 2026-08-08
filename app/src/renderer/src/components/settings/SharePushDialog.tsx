import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Btn, Chip, Skeleton } from '../ui'
import type { HivemindPushOutcome, PushReceipt, PushStatus } from '../../../../shared/hivemind'

/**
 * Preview → PR-title → push flow for sharing one user-tier asset to the
 * HiveMind. Used inline under a pushable row (HivemindSettings) and under a
 * just-accepted proposal (ProposalsPage) — same IPC as the original Share tab.
 *
 * A share PR may already be open for this asset. `pushStatus` decides which of four views this
 * renders: the normal flow, a blocked "already shared" (ours, unchanged), an "Update pull request"
 * variant (ours, changed), or a hard block on a teammate's PR. Main re-derives the same status
 * inside `push`, so this is presentation only — a stale value here cannot produce a duplicate PR.
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
  const [outcome, setOutcome] = useState<HivemindPushOutcome | null>(null)
  const [status, setStatus] = useState<PushStatus | null>(null)
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

  useEffect(() => {
    let mounted = true
    // Promise.resolve wrapper + catch: a preload without `pushStatus` (an older window still open
    // across an update) must degrade to the pre-existing share flow, not crash the dialog.
    void Promise.resolve()
      .then(() => window.argus.hivemind.pushStatus(kind, name))
      .catch(() => ({ state: 'none' }) as PushStatus)
      .then((s) => mounted && setStatus(s))
    return () => {
      mounted = false
    }
  }, [kind, name])

  // If the host unmounts the dialog mid-push anyway (e.g. tab switch), don't leave it gated.
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])

  async function doPush(): Promise<void> {
    if (busy) return
    setBusy(true)
    onBusyChange?.(true)
    setError(null)
    try {
      const r = await window.argus.hivemind.push(kind, name, title)
      if (r.ok) {
        setPrUrl(r.prUrl)
        setOutcome(r.outcome)
      } else setError(r.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  /** Terminal view: a PR exists and there is nothing left to do here. */
  function prResult(label: string, url: string): React.JSX.Element {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm">
        <Chip tone="signal">{label}</Chip>
        <Btn variant="ghost" onClick={() => void window.argus.openExternal(url)}>
          {url}
        </Btn>
        <Btn variant="outline" onClick={onClose}>
          Done
        </Btn>
      </div>
    )
  }

  if (prUrl) {
    // `outcome` distinguishes a real create/update from the no-op paths in `push()` (an
    // already-open PR with nothing new, or the worktree finding nothing staged after
    // re-deriving) — both of which used to render identically to a brand-new PR ("PR
    // opened"), telling the user a pull request was created when none was.
    const label =
      outcome === 'updated' ? 'PR updated' : outcome === 'created' ? 'PR opened' : 'Already shared'
    return prResult(label, prUrl)
  }
  if (status?.state === 'open-mine' && !status.changed)
    return prResult('Already shared', status.prUrl)

  if (status?.state === 'open-teammate') {
    return (
      <div className="flex flex-col gap-2 px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <Chip tone="signal">Already open</Chip>
          <Btn variant="ghost" onClick={() => void window.argus.openExternal(status.prUrl)}>
            {status.prUrl}
          </Btn>
          <Btn variant="outline" onClick={onClose}>
            Done
          </Btn>
        </div>
        <p className="text-xs text-dim">
          {status.prAuthor} already has this open. Pushing to someone else&apos;s branch is not
          Argus&apos;s call — review or merge that pull request first.
        </p>
      </div>
    )
  }

  const reusing = status?.state === 'open-mine' && status.changed

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
      {status?.state === 'none' && status.warning && (
        <p className="text-xs text-dim">
          Could not check for an existing pull request ({status.warning}) — sharing anyway may
          create a duplicate.
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="text-xs text-dim">PR title</span>
        {/* `bg-well`, not `bg-overlay` (Task 12 review finding 1): this dialog is embedded inline
            under a SettingRow in LibraryPage (a SettingsSection card) as well as inline under
            ProposalsPage's ground-level accepted-proposal row; `--well` and the wash are close
            enough in light that this reads correctly in both places, unlike `--bg-over`, which
            vanishes on the LibraryPage card. */}
        <input
          aria-label="PR title"
          className="h-7 min-w-0 flex-1 rounded-r2 border border-hair bg-well px-2 text-xs text-ink"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {preview === null ? (
        // The diff preview is the tallest thing in this dialog; bars hold its top few lines so
        // the buttons below do not jump down the moment it resolves.
        <div role="status" aria-label="Loading preview" className="flex flex-col gap-1.5 py-1">
          <Skeleton className="h-2 w-[80%]" />
          <Skeleton className="h-2 w-[65%]" />
          <Skeleton className="h-2 w-[90%]" />
          <Skeleton className="h-2 w-[45%]" />
        </div>
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-dim">
          {preview}
        </pre>
      )}
      <div className="flex items-center gap-2">
        <Btn
          variant="primary"
          disabled={busy || preview === null || !title.trim()}
          onClick={() => void doPush()}
        >
          {busy
            ? reusing
              ? 'Updating…'
              : 'Pushing…'
            : reusing
              ? 'Update pull request'
              : 'Open pull request'}
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
        <Btn variant="dangerSolid" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  )
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
