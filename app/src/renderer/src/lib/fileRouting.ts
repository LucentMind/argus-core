import type { FileNode } from '../../../shared/types'
import { MAX_WHOLE_FILE_BYTES } from '../../../shared/textdoc'

export type FileOpenTarget =
  | { kind: 'evidence'; evidenceId: number; focusStart: number; focusEnd: number }
  | { kind: 'file'; slug: string; relPath: string }

/** Route a case-file click: text evidence too large for FileViewer's whole-read
 *  cap goes to the line-indexed TextViewer (focusEnd 0 ⇒ open at top, no
 *  highlight); everything else keeps FileViewer's markdown/raw rendering. */
export function viewerForFileNode(slug: string, node: FileNode): FileOpenTarget {
  return node.evidence && node.size > MAX_WHOLE_FILE_BYTES
    ? { kind: 'evidence', evidenceId: node.evidence.id, focusStart: 1, focusEnd: 0 }
    : { kind: 'file', slug, relPath: node.relPath }
}
