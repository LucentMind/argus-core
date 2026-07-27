/**
 * Substitute `{name}` tokens in a resolved prompt template.
 *
 * Only used for entries that declare `placeholders`. An unknown token is left literal rather
 * than blanked: a blanked token deletes text from a model-facing message with no trace, while
 * a literal `{oops}` is visible in the output and in the session transcript. `\w+` with no
 * interior spaces means a JSON example like `{ "summary": … }` inside a prompt body is never
 * mistaken for a placeholder.
 */
export function fillPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match
  )
}
