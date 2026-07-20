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
  // The object URL is a disposable resource, so the effect that disposes it must
  // also OWN it (mint it), matching TextViewer's page-cache idiom. Minting it in a
  // lazy useState initializer instead breaks under StrictMode's dev-only
  // setup→cleanup→setup mount cycle: useState PRESERVES state across the simulated
  // remount, but the cleanup still revokes — so the second setup renders the
  // already-revoked URL from the first, with nothing to re-mint it. Owning it here
  // costs one extra render per chip but guarantees a REMOUNT always gets a fresh URL.
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!previewBlob) return
    const url = URL.createObjectURL(previewBlob)
    // Deferring this to a microtask (the repo's usual set-state-in-effect idiom,
    // see TextViewer's page-cache effect) does NOT work here: the `<img>` must
    // show the fresh url in the SAME commit the resource is minted, because a
    // consumer (this file's StrictMode test, and any real render right after a
    // remount) reads `previewUrl` synchronously off the DOM with no chance to
    // await a follow-up tick. This is a mount-only probe with controlled
    // setState, same category as SpaceDialog/ToolRow/HivemindSettings.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resource-owning effect must set state in the same commit it mints the URL
    setPreviewUrl(url)
    return () => {
      setPreviewUrl(undefined)
      URL.revokeObjectURL(url)
    }
  }, [previewBlob])

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
