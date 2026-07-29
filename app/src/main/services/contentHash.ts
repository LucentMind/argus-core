import crypto from 'node:crypto'

/**
 * Optimistic-concurrency token for a file the editor is holding open.
 *
 * Content hash rather than mtime: proposal-accept, hive install/claim, and refsync all rewrite
 * these files, and a restamp can produce identical second-granularity timestamps.
 */
export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}
