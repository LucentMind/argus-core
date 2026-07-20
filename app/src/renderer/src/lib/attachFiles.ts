import { composerAttachments, type Attachment } from './composerAttachments'
import { displayName } from './evidenceDisplay'

/** Anything larger is refused in the renderer, before the bytes cross IPC. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg'
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/**
 * Clipboard images arrive with no filename, so one is invented. Timestamp-first keeps
 * the evidence directory sortable and collision-free without a prompt.
 */
export function screenshotName(mimeType: string, now: Date): string {
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `screenshot-${stamp}.${EXT_BY_MIME[mimeType] ?? 'bin'}`
}

let seq = 0
const nextId = (): string => `att-${++seq}`

/**
 * Ingest dropped or pasted files as case evidence and stage them on the composer tray.
 *
 * Sequential by design: `collisionFreeName` in the main process reads the evidence
 * directory to pick a name, so concurrent writes can race to the same filename.
 * Never rejects — a failure is surfaced on its own chip so the other files still land.
 */
export async function attachFiles(
  caseSlug: string,
  sessionId: number,
  files: File[]
): Promise<void> {
  for (const file of files) {
    const isImage = file.type.startsWith('image/')
    const name = file.name || screenshotName(file.type, new Date())
    const id = nextId()

    if (file.size > MAX_ATTACHMENT_BYTES) {
      composerAttachments.add(caseSlug, sessionId, {
        id,
        name,
        status: 'error',
        error: `Too large — the limit is ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`
      })
      continue
    }

    const pending: Attachment = {
      id,
      name,
      status: 'pending',
      previewUrl: isImage ? URL.createObjectURL(file) : undefined
    }
    composerAttachments.add(caseSlug, sessionId, pending)

    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { record } = await window.argus.evidence.ingestContent(caseSlug, name, bytes)
      composerAttachments.update(caseSlug, sessionId, id, {
        status: 'ready',
        relPath: record.relPath,
        // a dedupe hit resolves to the ORIGINAL evidence name, not the pasted one
        name: displayName(record.relPath)
      })
    } catch (err) {
      composerAttachments.update(caseSlug, sessionId, id, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
