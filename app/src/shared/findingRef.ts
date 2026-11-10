/** The one parser of the `#<id>` an `append_finding` tool result carries (its registered text is
 *  `finding appended as #{id}`). Used by the chat transcript to find the finding a tool item
 *  recorded. Null when the preview has no `#<digits>` — the pre-increment wording, an empty
 *  in-flight preview, or an error result. */
export function findingIdFromToolOutput(output: string): number | null {
  const m = /#(\d+)/.exec(output)
  return m ? Number(m[1]) : null
}

/** The marker grammar `findings.ts` splits findings.md on (`<!-- finding:N -->`), with any
 *  whitespace: every model-written body passes through this before it is written, so a body
 *  that quotes a marker can never split the file into a phantom finding. The rewritten form
 *  `<!-- finding-ref:N -->` does not match the splitter. */
const FINDING_MARKER_RE = /<!--\s*finding:(\d+)\s*-->/g
export function escapeFindingMarkers(text: string): string {
  return text.replace(FINDING_MARKER_RE, '<!-- finding-ref:$1 -->')
}
