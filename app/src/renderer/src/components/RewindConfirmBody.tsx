import type { RewindPreview } from '../../../shared/branching'

/** The reason label under "Stays accepted" for a finding left untouched by the rewind. */
function stayingReasonLabel(reason: 'accepted' | 'already-retracted'): string {
  return reason === 'accepted' ? 'accepted' : 'already retracted'
}

/**
 * Body of the "Rewind N turns?" confirm dialog: what the discarded tail carries and what
 * happens to it — findings that get retracted vs. those that stay as they are, irreversible
 * tool calls that already happened and cannot be undone, and (native drivers only) which
 * files get restored to their pre-tail contents. A digest-branching driver's tail edits are
 * summarized by tool + count instead, with a caveat that files are not restored.
 */
export function RewindConfirmBody({ preview }: { preview: RewindPreview }): React.JSX.Element {
  const { tail, branching, findingsToRetract, findingsStaying, externalActions, files } = preview
  return (
    <div className="space-y-2 text-xs">
      <span className="block">
        {tail.length} turn{tail.length === 1 ? '' : 's'} will be discarded.
      </span>
      {/* What survives in the AGENT's head, from `preview.branching` — main's per-anchor answer.
          Deliberately its own line rather than a clause inside the file-restore block below:
          context and files are two different facts that merely correlate on the previews main
          produces today, and burying the sentence in the native-files branch is what let a
          digest rewind (native driver, anchor with no provider id — V2/V14) claim full context
          was kept. */}
      <span className="block text-mute">
        {branching === 'native'
          ? 'The agent keeps its full context up to this point.'
          : 'The agent receives a summary of the history up to this point.'}
      </span>
      {findingsToRetract.length > 0 && (
        <div>
          <span className="font-medium text-ink">Will be retracted</span>
          <ul className="list-disc pl-4">
            {findingsToRetract.map((f) => (
              <li key={f.id}>{f.summary}</li>
            ))}
          </ul>
        </div>
      )}
      {findingsStaying.length > 0 && (
        <div>
          <span className="font-medium text-ink">Stays accepted</span>
          <ul className="list-disc pl-4">
            {findingsStaying.map((f) => (
              <li key={f.id}>
                {f.summary} <span className="text-mute">({stayingReasonLabel(f.reason)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {externalActions.length > 0 && (
        <div>
          <span className="font-medium text-ink">Stays done</span>
          <ul className="list-disc pl-4">
            {externalActions.map((a) => (
              <li key={a.tool}>
                {a.tool} ×{a.count}
              </li>
            ))}
          </ul>
        </div>
      )}
      {files.kind === 'native' && files.error ? (
        // M4. The driver could not resolve a file anchor (no checkpoints for this session, or
        // the anchor is not in its transcript). Said plainly, and NOT under a "Files restored"
        // heading with a "0 skipped" count, which reads as a restore that found nothing to do.
        // The rewind still happens — main degrades it to a conversation-only branch.
        <div>
          <span className="font-medium text-ink">Files</span>
          <span className="block text-mute">
            Files cannot be restored: {files.error}. The conversation is still rewound.
          </span>
        </div>
      ) : files.kind === 'native' ? (
        <div>
          <span className="font-medium text-ink">Files restored</span>
          {files.restored.length > 0 && (
            <ul className="list-disc pl-4">
              {files.restored.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          <span className="block text-mute">
            {files.skipped} skipped{files.error ? ` — ${files.error}` : ''}.
          </span>
        </div>
      ) : (
        <div>
          <span className="font-medium text-ink">Files</span>
          <ul className="list-disc pl-4">
            {files.writes.map((w) => (
              <li key={w.tool}>
                {w.tool} ×{w.count}
              </li>
            ))}
          </ul>
          <span className="block text-mute">files are not restored on this provider.</span>
        </div>
      )}
    </div>
  )
}
