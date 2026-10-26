/** The one parser of the `#<id>` an `append_finding` tool result carries (its registered text is
 *  `finding appended as #{id}`). Used by the chat transcript to find the finding a tool item
 *  recorded. Null when the preview has no `#<digits>` — the pre-increment wording, an empty
 *  in-flight preview, or an error result. */
export function findingIdFromToolOutput(output: string): number | null {
  const m = /#(\d+)/.exec(output)
  return m ? Number(m[1]) : null
}
