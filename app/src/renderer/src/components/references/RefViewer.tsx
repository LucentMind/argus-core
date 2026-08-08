import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Btn, SkeletonDoc } from '../ui'
import { ModalShell } from '../ModalShell'
import { AuthorshipStrip } from './AuthorshipStrip'
import { fmBlock } from '../../../../shared/frontmatter'

/**
 * Rendered mode shows the body only. YAML frontmatter is not markdown, so passing the whole file
 * to react-markdown spilled `name: …`/`description: …` into the page as prose — and once assets
 * carried authorship, the contributor list rendered as a bulleted list of emails immediately
 * below the strip that already displays it. Raw mode still shows the file verbatim, which is the
 * mode you switch to when you want the frontmatter.
 */
function renderedBody(raw: string): string {
  return fmBlock(raw)?.body ?? raw
}

/** Generic modal markdown viewer (FileViewer idiom) — refs and skills share it. */
export function MarkdownViewer({
  title,
  ariaLabel,
  load,
  onClose,
  extraActions,
  showAuthorship = false
}: {
  title: string
  ariaLabel: string
  load: () => Promise<string>
  onClose: () => void
  /** Extra buttons for the header, left of the Raw/Rendered toggle. */
  extraActions?: React.ReactNode
  /** Show the author/contributors strip — assets only; a plain file viewer has no authorship. */
  showAuthorship?: boolean
}): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [raw, setRaw] = useState(false)

  useEffect(() => {
    load().then(setContent, () => setError(true))
    // load is mount-stable: callers remount (key/conditional render) per file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ModalShell
      title={title}
      onClose={onClose}
      ariaLabel={ariaLabel}
      variant="reading"
      className="h-[80vh] w-[80vw] max-w-4xl"
      actions={
        <>
          {extraActions}
          {content != null ? (
            <Btn variant="ghost" onClick={() => setRaw(!raw)}>
              {raw ? 'Rendered' : 'Raw'}
            </Btn>
          ) : null}
        </>
      }
    >
      {content != null && showAuthorship && <AuthorshipStrip raw={content} />}
      {error ? (
        <div className="flex flex-1 items-center justify-center text-sm text-dim">
          File could not be read.
        </div>
      ) : !raw ? (
        <div className="markdown-body flex-1 overflow-auto p-4 text-sm leading-relaxed text-ink">
          {content != null ? (
            <Markdown remarkPlugins={[remarkGfm]}>{renderedBody(content)}</Markdown>
          ) : (
            <SkeletonDoc />
          )}
        </div>
      ) : content != null ? (
        <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-5 text-dim">
          {content}
        </pre>
      ) : (
        <div className="flex-1 overflow-auto p-3">
          <SkeletonDoc />
        </div>
      )}
    </ModalShell>
  )
}

/** Modal markdown viewer for a reference file (refsync-served). */
export function RefViewer({
  file,
  onClose,
  extraActions,
  showAuthorship = false
}: {
  file: string
  onClose: () => void
  extraActions?: React.ReactNode
  /** Show the author/contributors strip — assets only; a plain file viewer has no authorship. */
  showAuthorship?: boolean
}): React.JSX.Element {
  return (
    <MarkdownViewer
      key={file}
      title={`references / ${file}`}
      ariaLabel={`reference · ${file}`}
      load={() => window.argus.refsync.readRef(file).then((r) => r.content)}
      onClose={onClose}
      extraActions={extraActions}
      showAuthorship={showAuthorship}
    />
  )
}
