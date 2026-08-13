import type { JiraAttachmentInfo } from '../../../shared/jira'

/**
 * Order attachments for display: by MIME type, then filename.
 *
 * Jira returns `fields.attachment` in upload order (ascending id), which scatters the
 * same kind of file across the list — with a ticket's worth of attachments the user is
 * hunting for "the logs" one row at a time. Grouping by type puts them together.
 *
 * Attachments with no MIME type sort last rather than first: an empty string would win
 * every comparison and float unknowns to the top of the list, which is the opposite of
 * what they deserve. Filename is the tiebreak so the order is total — equal keys would
 * otherwise leave the result at the mercy of the sort's stability.
 *
 * Case-insensitive, numeric collation, so `log2.txt` precedes `log10.txt`.
 */
export function sortAttachmentsByType<T extends JiraAttachmentInfo>(list: readonly T[]): T[] {
  const cmp = (a: string, b: string): number =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  return [...list].sort((x, y) => {
    const xt = x.mimeType.trim()
    const yt = y.mimeType.trim()
    if ((xt === '') !== (yt === '')) return xt === '' ? 1 : -1
    return cmp(xt, yt) || cmp(x.filename, y.filename)
  })
}
