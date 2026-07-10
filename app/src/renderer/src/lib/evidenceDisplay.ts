/** Display name for an evidence record: hides the storage-layout prefixes
 * (`evidence/`, and `.derived/` for extraction outputs) without touching the
 * underlying relPath used by the DB and skill suggestions. */
export function displayName(relPath: string): string {
  let name = relPath
  if (name.startsWith('evidence/')) name = name.slice('evidence/'.length)
  if (name.startsWith('.derived/')) name = name.slice('.derived/'.length)
  return name
}

const MB = 1024 * 1024

/** File size in megabytes with one decimal; below 0.1 MB collapses to "<0.1 MB". */
export function formatMb(bytes: number): string {
  const mb = bytes / MB
  if (Math.round(mb * 10) < 1) return '<0.1 MB'
  return `${mb.toFixed(1)} MB`
}
