import { useEffect, useState } from 'react'
import { renderMermaid } from '../lib/mermaid'

type Phase = { status: 'source' } | { status: 'ok'; svg: string } | { status: 'error' }

/** Renders a ```mermaid fence. While the message is still streaming (or until the
 *  debounced render lands) the raw source shows as a plain code block; a failed
 *  render keeps the code block and adds a note — never a blank hole. */
export function MermaidBlock({
  source,
  streaming = false
}: {
  source: string
  streaming?: boolean
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ status: 'source' })
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (streaming) return
    let cancelled = false
    // debounce: hydration/finalization can retrigger this effect in quick succession
    const t = setTimeout(() => {
      void renderMermaid(source).then((r) => {
        if (cancelled) return
        setPhase(r.ok ? { status: 'ok', svg: r.svg } : { status: 'error' })
      })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [source, streaming])

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  if (phase.status !== 'ok') {
    return (
      <div>
        <pre>
          <code>{source}</code>
        </pre>
        {phase.status === 'error' && (
          <div className="text-xs text-mute">diagram failed to render — showing source</div>
        )}
      </div>
    )
  }
  return (
    <>
      <div
        role="button"
        aria-label="Expand diagram"
        tabIndex={0}
        title="Click to expand"
        className="max-h-[28rem] cursor-zoom-in overflow-hidden rounded-r2 surface-card p-2 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-h-[27rem] [&_svg]:w-auto [&_svg]:max-w-full"
        onClick={() => setExpanded(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setExpanded(true)
        }}
        dangerouslySetInnerHTML={{ __html: phase.svg }}
      />
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center modal-scrim p-8"
          onClick={() => setExpanded(false)}
        >
          {/* `glass-panel`, not `bg-panel` (matches ModalShell's `variant="reading"`): this is a
              reading surface — a diagram at full size — so it gets the solid material with a
              border/shadow instead of a borderless white rectangle floating on the scrim. */}
          <div
            role="dialog"
            aria-label="Diagram"
            className="mermaid-lightbox glass-panel h-full w-full overflow-auto rounded-r3 p-4"
            onClick={(e) => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: phase.svg }}
          />
        </div>
      )}
    </>
  )
}
