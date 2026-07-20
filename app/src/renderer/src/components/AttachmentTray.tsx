import { useEffect, useState } from 'react'
import { Paperclip, Loader2, TriangleAlert } from 'lucide-react'
import type { Attachment } from '../lib/composerAttachments'

/**
 * Pending composer attachments. The ✕ detaches from the message only — it never deletes
 * the evidence, which is already a real case artifact under eager ingest. Deletion lives
 * in the Files card, and only there.
 */
export function AttachmentTray({
  attachments,
  onRemove
}: {
  attachments: Attachment[]
  onRemove: (id: string) => void
}): React.JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <AttachmentChip key={a.id} attachment={a} onRemove={onRemove} />
      ))}
    </div>
  )
}

/**
 * One chip, owning its own preview URL lifetime.
 *
 * The create-and-revoke MUST live here rather than in a tray-level effect: a
 * tray-level cleanup would close over whichever `attachments` array it was
 * created with, so URLs for attachments added later would leak. Keyed by
 * `id`, each chip unmounts exactly when its attachment goes away.
 *
 * The URL is minted from `previewBlob` on mount rather than stored on the
 * attachment itself, so that a chip that unmounts and later remounts (e.g.
 * `Composer` remounting on a session switch while `composerAttachments`
 * retains its data across that switch) always gets a fresh, unrevoked URL
 * instead of inheriting one this same chip already revoked last time.
 */
function AttachmentChip({
  attachment: a,
  onRemove
}: {
  attachment: Attachment
  onRemove: (id: string) => void
}): React.JSX.Element {
  const previewBlob = a.previewBlob
  // Lazy initializer: mints the URL synchronously during this chip's first
  // render, not in an effect body (setState-in-effect triggers cascading
  // renders). `previewBlob` is set once at attach time and never mutated
  // afterward, so it is stable for this chip's whole lifetime — the effect
  // below only needs to revoke on unmount, never to react to a blob change.
  const [previewUrl] = useState<string | undefined>(() =>
    previewBlob ? URL.createObjectURL(previewBlob) : undefined
  )
  useEffect(() => {
    if (!previewUrl) return
    return () => URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  return (
    <span
      title={a.status === 'error' ? a.error : a.relPath}
      className={`flex items-center gap-1.5 rounded-r2 border px-2 py-0.5 font-mono text-[11px] ${
        a.status === 'error'
          ? 'border-danger/60 bg-danger/10 text-danger'
          : 'border-hair bg-hi text-dim'
      }`}
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" className="h-5 w-5 rounded-r1 object-cover" />
      ) : a.status === 'error' ? (
        <TriangleAlert size={11} strokeWidth={1.5} />
      ) : (
        <Paperclip size={11} strokeWidth={1.5} />
      )}
      <span className={a.status === 'error' ? 'line-through' : undefined}>{a.name}</span>
      {a.status === 'pending' && <Loader2 size={11} className="animate-spin" />}
      <button
        type="button"
        title="Remove attachment"
        className="text-mute transition-colors hover:text-ink"
        onClick={() => onRemove(a.id)}
      >
        ×
      </button>
    </span>
  )
}
