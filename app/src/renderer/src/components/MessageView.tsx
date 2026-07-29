import { createContext, isValidElement, useContext } from 'react'
import type { ComponentProps } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  classifyCitePath,
  linkifyCitations,
  parseCiteHref,
  toRepoNameSet,
  type CiteTarget
} from '../lib/citations'
import { CitationCard } from './CitationCard'
import { MermaidBlock } from './MermaidBlock'
import type { CiteSource } from '../lib/snippetCache'

function citeSource(
  caseSlug: string,
  cite: CiteTarget,
  names: ReadonlySet<string>,
  repoCiteSha?: string
): CiteSource {
  if (classifyCitePath(cite.relPath, names) === 'repo') {
    const slash = cite.relPath.indexOf('/')
    return {
      kind: 'repo',
      caseSlug,
      repoName: cite.relPath.slice(0, slash),
      relPath: cite.relPath.slice(slash + 1),
      atSha: repoCiteSha
    }
  }
  // Evidence citations are immutable files — never pinned.
  return { kind: 'evidence', caseSlug, relPath: cite.relPath }
}

type MessageCtx = {
  onCite: (cite: CiteTarget) => void
  caseSlug?: string
  citationMode: 'collapsed' | 'expanded'
  names: ReadonlySet<string>
  streaming: boolean
  /** Pins repo-kind citation previews to this commit; evidence citations are never pinned. */
  repoCiteSha?: string
}

const Ctx = createContext<MessageCtx>({
  onCite: () => undefined,
  citationMode: 'collapsed',
  names: new Set(),
  streaming: false
})

/** The `components` map below MUST keep a stable identity across renders: React
 *  reconciles by element type, so a fresh arrow function per render unmounts and
 *  remounts the whole markdown subtree. That reset MermaidBlock back to its source
 *  code block (and collapsed expanded citations) on every streamed token of any
 *  message in the transcript. Per-message values therefore arrive by context,
 *  never by closure. */

// Expanded citation cards are block elements, which can't nest inside <p> —
// render paragraphs as divs (identical under preflight's zero margins).
function Paragraph({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <div>{children}</div>
}

function Pre({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- node prop from react-markdown must be destructured to prevent spreading onto DOM
  node: _node,
  children,
  ...rest
}: ComponentProps<'pre'> & { node?: unknown }): React.JSX.Element {
  const { streaming } = useContext(Ctx)
  const child = Array.isArray(children) ? children[0] : children
  if (isValidElement(child)) {
    const childProps = child.props as { className?: string; children?: unknown }
    if (
      typeof childProps.className === 'string' &&
      childProps.className.split(/\s+/).includes('language-mermaid') &&
      typeof childProps.children === 'string'
    ) {
      return <MermaidBlock source={childProps.children} streaming={streaming} />
    }
  }
  return <pre {...rest}>{children}</pre>
}

function Anchor({ href, children }: ComponentProps<'a'>): React.JSX.Element {
  const { onCite, caseSlug, citationMode, names, repoCiteSha } = useContext(Ctx)
  const cite = href ? parseCiteHref(href) : null
  if (cite && caseSlug) {
    return (
      <CitationCard
        source={citeSource(caseSlug, cite, names, repoCiteSha)}
        start={cite.start}
        end={cite.end}
        defaultExpanded={citationMode === 'expanded'}
        onOpenViewer={() => onCite(cite)}
      />
    )
  }
  if (cite) {
    return (
      <a
        href={href}
        className="font-mono text-xs text-defect underline decoration-dotted"
        onClick={(e) => {
          e.preventDefault()
          onCite(cite)
        }}
      >
        {children}
      </a>
    )
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-signal underline">
      {children}
    </a>
  )
}

const COMPONENTS = { p: Paragraph, pre: Pre, a: Anchor }
const REMARK_PLUGINS = [remarkGfm]
// the default transform strips unknown protocols like cite://
const urlTransform = (url: string): string =>
  url.startsWith('cite://') ? url : defaultUrlTransform(url)

export function MessageView({
  markdown,
  onCite,
  caseSlug,
  citationMode = 'collapsed',
  repoNames = [],
  streaming = false,
  repoCiteSha
}: {
  markdown: string
  onCite: (cite: CiteTarget) => void
  /** When set, citations render as CitationCard chips; without it (e.g. the
   *  proposals tab, which has no case context) they stay plain links. */
  caseSlug?: string
  citationMode?: 'collapsed' | 'expanded'
  /** Linked repo names for this case — enables the repo citation domain. */
  repoNames?: readonly string[]
  /** True while this message is still streaming — mermaid fences stay as code
   *  blocks until the fence is guaranteed complete. */
  streaming?: boolean
  /** Pins repo-kind citation previews to this commit (a review finding's `head_sha`) instead of
   *  the live worktree. Evidence citations are never pinned — see `citeSource`. */
  repoCiteSha?: string
}): React.JSX.Element {
  const names = toRepoNameSet(repoNames)
  return (
    <div className="markdown-body max-w-none text-sm leading-relaxed text-ink">
      <Ctx.Provider value={{ onCite, caseSlug, citationMode, names, streaming, repoCiteSha }}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          urlTransform={urlTransform}
          components={COMPONENTS}
        >
          {linkifyCitations(markdown, repoNames)}
        </ReactMarkdown>
      </Ctx.Provider>
    </div>
  )
}
