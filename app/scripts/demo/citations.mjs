/**
 * Verbatim mirror of `makeCitationRe()` in `src/shared/citations.ts`.
 *
 * The seed cannot import that module (it is TypeScript, and this is a plain .mjs script run
 * straight from node), so the grammar is duplicated here by hand — same caveat as
 * CASE_WORKING_RULES in demo/cases.mjs: if the real grammar changes, change this too.
 *
 * It matters that this is the SAME grammar rather than an approximation. verify() uses it to
 * decide which `[path:line]` spans in the seeded prose are real citations that must resolve
 * against a real file. A looser pattern here would fail the seed over prose like `[nav-sdk]`;
 * a stricter one would quietly skip citations the renderer will happily turn into links, which
 * is precisely the case where a broken link ships.
 */

/** Path is colon-free but may contain spaces and single-level `[..]` groups. */
const PATH_SUB = String.raw`(?:[^\[\]:]|\[[^\[\]]*\])+`
/** One or more comma-separated line numbers or `start-end` ranges. */
const LINESPEC_SUB = String.raw`\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*`

/** A FRESH regex per call: the `g` flag carries `lastIndex` across uses. */
export function makeCitationRe() {
  return new RegExp(String.raw`\[(${PATH_SUB}):(${LINESPEC_SUB})\](?!\()`, 'g')
}
