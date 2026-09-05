import { useState, type ReactNode } from 'react'

/**
 * Collapses a run of rewound turns under a divider, expanding — muted and inert — on demand.
 * `pointer-events-none` on the expanded body plus rendering no per-item actions inside it (the
 * caller's `renderItem` is told `{ rewound: true }` so Task 11's TurnActions never mounts here)
 * is what removes every interactive affordance from a rewound turn: it is history, not a place
 * to click.
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
          className="underline hover:text-dim"
          onClick={() => setOpen(!open)}
        >
          {open ? 'hide' : 'show'}
        </button>
        <span className="h-px flex-1 bg-hair" />
      </div>
      {open && <div className="pointer-events-none mt-2 space-y-3 opacity-50">{children}</div>}
    </div>
  )
}
