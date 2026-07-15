import { useEffect, useState } from 'react'

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function readRect(anchor: string): Rect | null {
  const el = document.querySelector(`[data-onboarding-anchor="${anchor}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

export function Coachmark({
  anchor,
  children
}: {
  anchor: string
  children: React.ReactNode
}): React.JSX.Element {
  const [rect, setRect] = useState<Rect | null>(() => readRect(anchor))

  useEffect(() => {
    const update = (): void => setRect(readRect(anchor))
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  if (!rect) {
    // fallback: centered callout, no ring — the tour never dead-ends
    return (
      <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center">
        <div className="pointer-events-auto max-w-sm">{children}</div>
      </div>
    )
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]">
      <div
        data-testid="coachmark-ring"
        className="absolute rounded-r2 ring-2 ring-signal ring-offset-2 ring-offset-void"
        style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      />
      <div
        className="pointer-events-auto absolute max-w-sm"
        style={{ top: rect.top + rect.height + 8, left: rect.left }}
      >
        {children}
      </div>
    </div>
  )
}
