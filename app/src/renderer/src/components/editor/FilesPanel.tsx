import type { SkillFileEntry } from '../../../../shared/skillFilesIpc'

export interface FilesPanelProps {
  files: SkillFileEntry[]
  /** The sibling the active tab is showing, so the list can mark it. Null = the skill's SKILL.md. */
  activeFile: string | null
  /** The containing skill's editability. A sibling is never editable inside a read-only skill. */
  editable: boolean
  onOpen: (relPath: string) => void
  onAdd: () => void
  onRename: (relPath: string) => void
  onDelete: (relPath: string) => void
}

/**
 * The active skill's folder, as a dock tab rather than a standing sidebar (spec §6): the window
 * is already tab strip + surface + dock, and at most 32 files does not earn a column.
 *
 * The mutation buttons are an affordance only — every one of them calls an IPC handler that
 * re-derives the skill's tier from disk and can refuse.
 */
export function FilesPanel({
  files,
  activeFile,
  editable,
  onOpen,
  onAdd,
  onRename,
  onDelete
}: FilesPanelProps): React.JSX.Element {
  return (
    <div className="p-2">
      {editable && (
        <button
          type="button"
          className="mb-2 text-xs text-dim underline-offset-2 hover:text-ink hover:underline"
          onClick={onAdd}
        >
          Add file…
        </button>
      )}
      {files.length === 0 ? (
        <div className="text-xs text-mute">No files yet.</div>
      ) : (
        <ul>
          {files.map((f) => (
            <li key={f.relPath} className="flex items-center gap-2">
              <button
                type="button"
                aria-current={activeFile === f.relPath ? 'true' : undefined}
                className="flex-1 text-left font-mono text-xs text-ink"
                onClick={() => onOpen(f.relPath)}
              >
                {f.relPath}
              </button>
              {f.executable && <span className="text-[10.5px] text-mute">exec</span>}
              {editable && (
                <>
                  <button
                    type="button"
                    aria-label={`Rename ${f.relPath}`}
                    className="text-[10.5px] text-dim hover:text-ink"
                    onClick={() => onRename(f.relPath)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${f.relPath}`}
                    className="text-[10.5px] text-dim hover:text-ink"
                    onClick={() => onDelete(f.relPath)}
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
