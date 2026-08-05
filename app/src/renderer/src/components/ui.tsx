import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import { Check } from 'lucide-react'

const CHIP_TONES = {
  neutral: 'text-dim border-hair',
  defect: 'text-defect border-defect/30',
  danger: 'text-danger border-danger/30',
  signal: 'text-signal border-signal/30',
  review: 'text-review border-review/30'
} as const

export function Chip({
  tone = 'neutral',
  title,
  onClick,
  'aria-label': ariaLabel,
  children
}: {
  tone?: keyof typeof CHIP_TONES
  title?: string
  /** With a handler the chip is a real button (pointer + hover affordance); without one it
   *  stays the inert span it always was. */
  onClick?: () => void
  'aria-label'?: string
  children: ReactNode
}): React.JSX.Element {
  const cls = `inline-flex items-center gap-1 rounded-r1 border bg-hair/50 px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wide ${CHIP_TONES[tone]}`
  if (onClick) {
    return (
      <button
        type="button"
        title={title}
        aria-label={ariaLabel}
        onClick={onClick}
        className={`${cls} cursor-pointer transition-colors hover:bg-hair`}
      >
        {children}
      </button>
    )
  }
  return (
    <span title={title} aria-label={ariaLabel} className={cls}>
      {children}
    </span>
  )
}

export function Card({
  className = '',
  variant = 'default',
  style,
  onClick,
  children
}: {
  className?: string
  /** 'glass' renders the liquid-glass material (theme-dynamic.css) with its cursor-tracked
   *  ring/sheen layers; the ring/sheen only light up inside a `.dyn-home` scope. The default
   *  variant carries `.surface-card` (main.css), which is flat in dark and frosted in light. */
  variant?: 'default' | 'glass'
  style?: React.CSSProperties
  onClick?: () => void
  children: ReactNode
}): React.JSX.Element {
  if (variant === 'glass') {
    return (
      <div
        onClick={onClick}
        style={style}
        className={`glass-card rounded-r3 ${onClick ? 'cursor-pointer' : ''} ${className}`}
      >
        <i className="gc-ring" aria-hidden="true" />
        <i className="gc-sheen" aria-hidden="true" />
        {children}
      </div>
    )
  }
  return (
    <div
      onClick={onClick}
      style={style}
      className={`rounded-r3 surface-card transition-colors ${onClick ? 'cursor-pointer hover:border-hair2 hover:bg-hi' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

export function SectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-mute">
      {children}
    </div>
  )
}

/* Everything EXCEPT the box metrics, which `BTN_SIZE` supplies. */
const BTN_BASE =
  'inline-flex shrink-0 items-center leading-none gap-1.5 whitespace-nowrap rounded-r2 border text-xs font-medium transition-colors disabled:opacity-40'

/* Box metrics are interpolated into the class string rather than appended by the caller: a
   caller-supplied `h-5 px-0` lands after the base `h-7 px-3` in the same `class`, but both are
   single-class selectors of equal specificity, so stylesheet order decides — and Tailwind emits
   `.h-5`/`.px-0` before `.h-7`/`.px-3`, so the base always won and the override was silently
   inert. jsdom resolves no cascade, so no test can catch that regression. Same reasoning as
   `ICON_BTN_SIZE` below. */
const BTN_SIZE = {
  /* One size for every button so mixed rows stay aligned (OEH .btn). */
  md: 'h-7 px-3',
  /* Square icon trigger matching IconBtn's `xs`, for dense rails. */
  iconXs: 'h-5 w-5 justify-center px-0'
} as const

const BTN_VARIANTS = {
  primary: 'border-transparent bg-signal text-void transition-all hover:brightness-110',
  ghost: 'border-transparent text-dim hover:bg-hair hover:text-ink',
  outline: 'border-hair2 text-ink hover:border-faint hover:bg-hair',
  danger: 'border-danger/40 text-danger hover:bg-danger/10',
  /* Filled counterpart to `primary` for destructive/dismiss actions beside it. */
  dangerSolid: 'border-transparent bg-danger text-void transition-all hover:brightness-110'
} as const

export function Btn({
  variant = 'outline',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BTN_VARIANTS
  size?: keyof typeof BTN_SIZE
}): React.JSX.Element {
  return (
    <button
      {...props}
      className={`${BTN_BASE} ${BTN_SIZE[size]} ${BTN_VARIANTS[variant]} ${className}`}
    />
  )
}

/* Small square icon button. `md` is the top-bar control; `sm` fits tight footer slots; `xs` is
   for dense list rows, where an md square exactly fills a `h-7` row and its hover fill reads as
   highlighting the whole row rather than as a control inside it. */
const ICON_BTN_SIZE = {
  xs: 'h-5 w-5',
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
  /* Library row actions (user-directed, 2026-08-05): 1.5x `sm`, the row's old size. */
  lg: 'h-9 w-9'
} as const

export function IconBtn({
  className = '',
  size = 'md',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Defaults to the top-bar 'md'. Interpolated into the base string rather than appended by
   *  the caller: a caller-supplied `h-5 w-5` lands after the base `h-7 w-7` in the same
   *  `class`, but both are single-class selectors of equal specificity, so stylesheet order
   *  decides — and Tailwind emits `.h-5`/`.h-6` before `.h-7`, so the base always won and the
   *  override was silently inert. Attribute order is irrelevant. jsdom resolves no cascade,
   *  so no test can catch that regression. */
  size?: keyof typeof ICON_BTN_SIZE
}): React.JSX.Element {
  return (
    <button
      {...props}
      className={`inline-flex ${ICON_BTN_SIZE[size]} shrink-0 items-center justify-center rounded-r2 text-dim transition-colors hover:bg-hair hover:text-ink disabled:opacity-40 ${className}`}
    />
  )
}

export interface MenuItem {
  label: string
  /** Native tooltip for the row, e.g. a full path when `label` is only a basename that may
   *  collide with another row's. */
  title?: string
  /** Leaf action. Omitted on parent items that only carry a submenu. */
  onSelect?: () => void
  tone?: 'default' | 'danger'
  disabled?: boolean
  /** When present, this row is a submenu parent: selecting is replaced by
   *  revealing these nested items (one level of nesting). */
  children?: MenuItem[]
}

const MENU_ITEM_BASE = 'block w-full rounded-r2 px-3 py-1.5 text-left text-sm hover:bg-hair/50'

/** Renders `children` into `document.body` when `portal`, otherwise in place. Local to this
 *  module (not exported) so `react-refresh/only-export-components` stays satisfied. */
function MaybePortal({
  portal,
  children
}: {
  portal: boolean
  children: ReactNode
}): React.JSX.Element {
  return <>{portal ? createPortal(children, document.body) : children}</>
}

/** Button + anchored dropdown menu. Closes on select, Escape, or outside click.
 *  Items with `children` expand into a nested submenu on hover or click. */
export function MenuButton({
  label,
  items,
  variant = 'ghost',
  align = 'right',
  onOpenChange,
  triggerClassName = '',
  size = 'md',
  'aria-label': ariaLabel,
  title,
  nocaret = false,
  portal = false
}: {
  label: React.ReactNode
  items: MenuItem[]
  variant?: 'primary' | 'ghost' | 'outline'
  /** Which edge the dropdown anchors to. 'right' opens leftward (default, for
   *  right-aligned triggers); 'left' opens rightward so triggers near the left
   *  screen edge don't clip. */
  align?: 'left' | 'right'
  /** Notified whenever the dropdown opens/closes. Used by callers (e.g. the panel launcher)
   *  that must hide a native overlay while the DOM menu is up. Also fired false on unmount. */
  onOpenChange?: (open: boolean) => void
  /** Extra classes for the trigger button, e.g. to keep a case-id trigger looking
   *  like its heading rather than a generic button. */
  triggerClassName?: string
  /** Box metrics for the trigger. `iconXs` matches IconBtn's `xs` for dense rails. */
  size?: keyof typeof BTN_SIZE
  'aria-label'?: string
  /** Native tooltip for the trigger. `aria-label` alone gives the button an accessible
   *  name but browsers don't surface it as a hover tooltip — icon-only triggers (e.g.
   *  the panel launcher's icon-only "New panel") need this for a sighted affordance. */
  title?: string
  /** When true, suppress the trailing caret that indicates a menu. Used by action-menu
   *  triggers that provide their own visual indicator (e.g. an ellipsis). */
  nocaret?: boolean
  /** Render the panel into `document.body` as a FIXED overlay instead of an absolutely
   *  positioned child.
   *
   *  Needed whenever the trigger sits inside a scroll container. An absolutely positioned
   *  panel is clipped by any ancestor whose `overflow` is not `visible`, and no `z-index`
   *  can escape that — clipping is not paint order. The case rail is the live example:
   *  its sections live in a `overflow-y-auto` box whose bottom edge falls just below the
   *  Repos card, so the panel was cut mid-list (measured: panel 141..214, clipper ends at
   *  201, and `elementFromPoint` at the panel's bottom returned the `<aside>`, not the menu).
   *
   *  A fixed panel cannot follow a scrolling anchor, so the menu closes on scroll/resize
   *  rather than drifting away from its trigger. */
  portal?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [openUp, setOpenUp] = useState(false)
  /** Trigger rect captured at open time — the fixed panel positions against it. */
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  /** The portalled panel is NOT inside `ref`, so the outside-click check must consult it
   *  separately; otherwise a click on a menu item reads as "outside", closes the menu on
   *  mousedown, and the item's own click never fires. */
  const panelRef = useRef<HTMLDivElement>(null)
  // Index of the currently-expanded submenu parent, or null.
  const [openSub, setOpenSub] = useState<number | null>(null)
  // Whether the open submenu was opened by hover. Pointer input fires mouseenter
  // before the click lands, so a click that follows hover must not toggle the
  // submenu shut again; a click with no preceding hover (keyboard Enter/Space, or
  // a menu that renders under an already-stationary pointer) still toggles.
  const hoverOpenedSub = useRef(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    onOpenChange?.(open)
    return () => {
      if (open) onOpenChange?.(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  // A fixed panel is positioned against a rect captured at open time, so it cannot follow a
  // scrolling or resizing anchor. Close instead of letting it drift away from its trigger.
  // Capture phase: the scroll happens on an inner container, which does not bubble to window.
  useEffect(() => {
    if (!open || !portal) return
    const close = (): void => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, portal])
  return (
    <div className="relative" ref={ref}>
      <Btn
        variant={variant}
        size={size}
        onClick={() => {
          // Flip upward when there isn't room below (e.g. trigger sits near the bottom of
          // the settings panel) so the menu never renders off-screen or under other chrome.
          const rect = ref.current?.getBoundingClientRect()
          setOpenUp(Boolean(rect && window.innerHeight - rect.bottom < 220 && rect.top > 220))
          setAnchor(rect ?? null)
          // reset any expanded submenu so each open starts collapsed. The hover flag
          // resets too: a row unmounted while hovered never fires its mouseleave.
          hoverOpenedSub.current = false
          setOpenSub(null)
          setOpen((o) => !o)
        }}
        aria-label={ariaLabel}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClassName}
      >
        {label} {!nocaret && <span aria-hidden="true">▾</span>}
      </Btn>
      {open && (
        <MaybePortal portal={Boolean(portal && anchor)}>
          <div
            ref={panelRef}
            role="menu"
            style={
              portal && anchor
                ? ({
                    position: 'fixed',
                    ...(openUp
                      ? { bottom: window.innerHeight - anchor.top + 4 }
                      : { top: anchor.bottom + 4 }),
                    ...(align === 'left'
                      ? { left: anchor.left }
                      : { right: window.innerWidth - anchor.right })
                  } as CSSProperties)
                : undefined
            }
            className={
              portal && anchor
                ? 'z-50 min-w-44 rounded-r2 overlay-menu p-1'
                : `absolute z-30 min-w-44 rounded-r2 overlay-menu p-1 ${
                    openUp ? 'bottom-full mb-1' : 'mt-1'
                  } ${align === 'left' ? 'left-0' : 'right-0'}`
            }
          >
            {items.map((it, i) =>
              it.children ? (
                <div
                  key={`${i}-${it.label}`}
                  className="relative"
                  onMouseEnter={() => {
                    hoverOpenedSub.current = true
                    setOpenSub(i)
                  }}
                  onMouseLeave={() => {
                    hoverOpenedSub.current = false
                    setOpenSub(null)
                  }}
                >
                  <button
                    role="menuitem"
                    title={it.title}
                    aria-haspopup="menu"
                    aria-expanded={openSub === i}
                    className={`flex items-center justify-between ${MENU_ITEM_BASE} text-ink`}
                    onClick={() =>
                      setOpenSub((s) => (s === i && !hoverOpenedSub.current ? null : i))
                    }
                  >
                    <span>{it.label}</span>
                    <span aria-hidden="true" className="ml-3 text-mute">
                      ▸
                    </span>
                  </button>
                  {openSub === i && (
                    // Outer wrapper abuts the parent button (left-full, no margin) and
                    // carries the 4px offset as transparent left padding, so the gap
                    // between row and panel is a *hoverable* strip that keeps the pointer
                    // inside this DOM subtree. A bare `ml-1` margin leaves the pointer
                    // over neither element mid-cross, firing the parent's onMouseLeave
                    // and closing the submenu before it can be reached.
                    <div className="absolute left-full top-0 z-40 pl-1">
                      <div role="menu" className="min-w-44 rounded-r2 overlay-menu p-1">
                        {it.children.map((sub, j) => (
                          <button
                            key={`${j}-${sub.label}`}
                            role="menuitem"
                            title={sub.title}
                            disabled={sub.disabled}
                            className={`${MENU_ITEM_BASE} disabled:opacity-50 ${
                              sub.tone === 'danger' ? 'text-danger' : 'text-ink'
                            }`}
                            onClick={() => {
                              setOpen(false)
                              sub.onSelect?.()
                            }}
                          >
                            {sub.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  key={`${i}-${it.label}`}
                  role="menuitem"
                  title={it.title}
                  disabled={it.disabled}
                  className={`${MENU_ITEM_BASE} disabled:opacity-50 ${
                    it.tone === 'danger' ? 'text-danger' : 'text-ink'
                  }`}
                  onClick={() => {
                    setOpen(false)
                    it.onSelect?.()
                  }}
                >
                  {it.label}
                </button>
              )
            )}
          </div>
        </MaybePortal>
      )}
    </div>
  )
}

/**
 * One shimmering placeholder block. Size it with `className` (`h-2 w-3/4`); the shimmer itself,
 * including its reduced-motion fallback, is `argus-shimmer` in main.css.
 *
 * `aria-hidden` because a skeleton conveys "not yet", which the absence of content already
 * conveys — announcing a row of grey boxes is noise.
 */
export function Skeleton({ className = '' }: { className?: string }): React.JSX.Element {
  return <span aria-hidden="true" className={`block argus-shimmer ${className}`} />
}

/** `count` chip-shaped placeholder stacks, for a list that has not loaded yet. */
export function SkeletonRows({ count = 3 }: { count?: number }): React.JSX.Element {
  return (
    <div aria-hidden="true" data-testid="skeleton-rows" className="flex flex-col gap-2 py-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-1">
          <Skeleton className="h-2.5 w-[60%]" />
          <Skeleton className="h-2 w-[85%]" />
        </div>
      ))}
    </div>
  )
}

/**
 * Checkbox with a drawn box.
 *
 * The input stays in the DOM as `sr-only peer` rather than `hidden`: it must remain focusable,
 * label-queryable and clickable — `hidden` would take it out of the accessibility tree and break
 * both keyboard use and every `getByLabelText` in the suite.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  'aria-label': ariaLabel
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  'aria-label'?: string
}): React.JSX.Element {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-dim">
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span className="grid h-3.5 w-3.5 place-items-center rounded-r1 border border-hair2 bg-overlay text-void transition-colors peer-checked:border-signal peer-checked:bg-signal peer-focus-visible:border-faint">
        {/* The tick is driven from React state, not `peer-checked:` — `peer-*` only matches
            later SIBLINGS of the peer, and this svg is a descendant of one, so the variant
            would never fire. The box itself is a sibling, so it can use peer-checked. */}
        <Check
          size={10}
          strokeWidth={3.5}
          className={checked ? 'opacity-100' : 'opacity-0'}
          aria-hidden="true"
        />
      </span>
      {label}
    </label>
  )
}

/**
 * Labelled switch — the same track-and-knob material as settings' bare `Switch`, plus the text
 * that names what it controls.
 *
 * Distinct from {@link Checkbox} by *meaning*, not by taste: a checkbox states a value that some
 * later action will read, a switch takes effect the moment it moves. Anything that re-filters a
 * list under the user's cursor is the second kind.
 *
 * Built on a `<button role="switch">` rather than Checkbox's hidden `<input>`. The knob has to
 * move on state and the track has to fill, and both are React-state reads — driving them from
 * `peer-checked:` would need the knob to be a SIBLING of the input, which it cannot be while the
 * track wraps it. `aria-checked` carries the state, so `getByRole('switch', { checked })` sees it.
 */
export function Toggle({
  checked,
  onChange,
  label,
  'aria-label': ariaLabel
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  'aria-label'?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className="inline-flex cursor-pointer select-none items-center gap-2 text-xs text-dim transition-colors hover:text-ink"
      onClick={() => onChange(!checked)}
    >
      <span
        aria-hidden="true"
        className={`relative block h-4 w-7 shrink-0 rounded-full border transition-colors ${
          checked ? 'border-signal/50 bg-signal/30' : 'border-hair2 bg-overlay'
        }`}
      >
        {/* Geometry, so the knob is actually centred rather than nearly: the track is h-4/w-7 with
            a 1px border, i.e. a 14×26 inner box, and the knob is 10px. That leaves 2px above and
            below (mt-[2px]) and travel from 2px to 26-10-2 = 14px. */}
        <span
          className={`mt-[2px] block h-2.5 w-2.5 rounded-full transition-[transform,background-color] ${
            checked ? 'translate-x-[14px] bg-signal' : 'translate-x-[2px] bg-mute'
          }`}
        />
      </span>
      {label}
    </button>
  )
}
