import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import type { Extension } from '@codemirror/state'

/**
 * The one content type this editor serves: markdown with an optional YAML frontmatter block.
 *
 * Spec §5.3 requires this composition to be verified empirically rather than read off a `.d.ts`,
 * because the frontmatter helper has moved between packages across CodeMirror releases. Verified
 * against `@codemirror/lang-yaml@6.1.3` + `@codemirror/lang-markdown@6.5.1`: this yields a
 * `Frontmatter` node over the fenced head and a markdown `Document` over the rest, for LF and
 * CRLF alike, and degrades to plain markdown when there is no fence. `extensions/__tests__/
 * language.test.ts` is that verification, kept so a version bump that moves it again fails
 * loudly.
 *
 * `base: markdownLanguage` rather than the default CommonMark base: it enables GFM, which is
 * what `remark-gfm` gives the preview — the two halves of a split view disagreeing about
 * whether a table is a table would be worse than neither having it.
 */
export function assetLanguage(): Extension {
  return yamlFrontmatter({ content: markdown({ base: markdownLanguage }) })
}
