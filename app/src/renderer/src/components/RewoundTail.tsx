import { useState, type ReactNode } from 'react'

/**
 * Collapses a run of rewound turns under a divider, expanding — muted and inert — on demand.
 * The expanded body carries the HTML `inert` attribute, which Chromium (and React 19, which
 * accepts `inert` as a plain boolean prop) removes from the tab order and blocks activation of
 * entirely: a `ToolCallCard`'s toggle button and a `CitedText`/`MessageView` citation link inside
 * a rewound turn cannot be tabbed to or activated, keyboard or otherwise. `pointer-events-none` +
 * `opacity-50` cover the pointer/visual side for the same content, and the caller's `renderItem`
 * is told `{ rewound: true }` here (`{ rewound: false }` for live items) so Task 11's TurnActions
 * never mounts inside a rewound turn in the first place. Together: it is history, not a place to
 * click.
 */
export function RewoundTail({
  turnCount,
  at,
  children
}: {
  turnCount: number
  at: string
  children: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const label = `Rewound ${turnCount} turn${turnCount === 1 ? '' : 's'}`
  return (
    <div data-rewound className="my-2">
      <div className="flex items-center gap-2 text-[11px] text-mute">
        <span className="h-px flex-1 bg-hair" />
        <span>
          {label} · {new Date(at).toLocaleString()}
        </span>
        <button
          type="button"
          aria-label={open ? 'hide rewound turns' : 'show rewound turns'}
          aria-expanded={open}
          className="underline hover:text-dim"
          onClick={() => setOpen(!open)}
        >
          {open ? 'hide' : 'show'}
        </button>
        <span className="h-px flex-1 bg-hair" />
      </div>
      {open && (
        <div inert className="pointer-events-none mt-2 space-y-3 opacity-50">
          {children}
        </div>
      )}
    </div>
  )
}
