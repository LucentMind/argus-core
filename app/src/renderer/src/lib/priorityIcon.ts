import {
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  Equal,
  type LucideIcon
} from 'lucide-react'

export interface PriorityIcon {
  Icon: LucideIcon
  /** Tailwind text-* class — the glyph strokes from currentColor. */
  className: string
}

const HIGHEST: PriorityIcon = { Icon: ChevronsUp, className: 'text-danger' }
const HIGH: PriorityIcon = { Icon: ChevronUp, className: 'text-danger' }
const MEDIUM: PriorityIcon = { Icon: Equal, className: 'text-defect' }
const LOW: PriorityIcon = { Icon: ChevronDown, className: 'text-signal' }
const LOWEST: PriorityIcon = { Icon: ChevronsDown, className: 'text-signal' }

/**
 * The three priority vocabularies we have actually seen on real projects, collapsed onto one set
 * of five glyphs: Jira's default names, the P0–P4 codes, and the severity words. Only one red
 * token exists, so Highest and High share `--danger` and are told apart by the glyph, the way
 * Jira itself distinguishes them.
 */
const TABLE: Record<string, PriorityIcon> = {
  p0: HIGHEST,
  highest: HIGHEST,
  blocker: HIGHEST,
  critical: HIGHEST,
  p1: HIGH,
  high: HIGH,
  major: HIGH,
  p2: MEDIUM,
  medium: MEDIUM,
  normal: MEDIUM,
  p3: LOW,
  low: LOW,
  minor: LOW,
  p4: LOWEST,
  lowest: LOWEST,
  trivial: LOWEST
}

/**
 * Glyph + colour for a Jira priority name, or null when the value is unset or belongs to a
 * scheme we don't recognise.
 *
 * Null is not "draw nothing": priority schemes are per-project (CaseDashboard derives its filter
 * menu from the values on screen rather than hardcoding them), so the caller falls back to
 * printing the word. Losing the icon is acceptable; losing the priority is not.
 *
 * Deliberately separate from `railTier`, which collapses these five into three tiers — the rail
 * wants coarse bands, an icon set needs every step distinguished.
 */
export function priorityIconFor(priority: string | null | undefined): PriorityIcon | null {
  if (!priority) return null
  return TABLE[priority.toLowerCase()] ?? null
}
