import type { ComponentProps } from 'react'
import { isOpenableUrl } from './openableUrl'

/** Spec §12.1: `description` and comment `body` are untrusted third-party
 *  markdown. react-markdown's default `urlTransform` only blanks dangerous
 *  *schemes* (`javascript:`, `file:`, app protocols) — an ordinary
 *  `https://` link still renders with no `target`/`rel`, which is a
 *  same-window top-level navigation that never reaches the main-process
 *  `setWindowOpenHandler` guard. Force every markdown link through the same
 *  `isOpenableUrl` gate as a record's own `url`, and force it to
 *  open via `target="_blank"` so a click is routed through that guard
 *  instead of replacing this window.
 *
 *  Lives here rather than beside one consumer because the same untrusted bytes
 *  reach the screen by two routes: the related-history detail pane renders a
 *  corpus record live, and an attached snapshot writes that same
 *  `description`/`body` into `evidence/<KEY>.md`, which opens in `FileViewer`.
 *  One definition, so hardening one route cannot silently leave the other bare. */
export function MarkdownAnchor({ href, children }: ComponentProps<'a'>): React.JSX.Element {
  if (href && isOpenableUrl(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  }
  return <>{children}</>
}

/** Pass to every `<Markdown>` that renders content this app did not author.
 *  Note there is no `rehype-raw` anywhere in these subtrees either — that is
 *  the sanitizing path spec §12.2 requires, and adding it would reopen the
 *  hole this gate closes. This — not the component — is what consumers should
 *  import: the value of extracting the gate is that every renderer of untrusted
 *  markdown passes the SAME object, so hardening one route cannot leave another
 *  bare. */
// eslint-disable-next-line react-refresh/only-export-components -- constant co-located with the single component it configures; see MetricCards.tsx for the same pattern
export const MARKDOWN_COMPONENTS = { a: MarkdownAnchor }
