import { describe, it, expect } from 'vitest'
import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, Equal } from 'lucide-react'
import { priorityIconFor } from '../priorityIcon'

describe('priorityIconFor', () => {
  it('maps the default Jira scheme, case-insensitively', () => {
    expect(priorityIconFor('Highest')?.Icon).toBe(ChevronsUp)
    expect(priorityIconFor('HIGH')?.Icon).toBe(ChevronUp)
    expect(priorityIconFor('Medium')?.Icon).toBe(Equal)
    expect(priorityIconFor('low')?.Icon).toBe(ChevronDown)
    expect(priorityIconFor('Lowest')?.Icon).toBe(ChevronsDown)
  })

  // Per-project schemes: the dashboard derives its priority menu from whatever the cases carry,
  // so the codes and the severity words have to land on the same five glyphs as the names.
  it('maps the P-code and severity-word schemes onto the same glyphs', () => {
    expect(priorityIconFor('P0')?.Icon).toBe(ChevronsUp)
    expect(priorityIconFor('Blocker')?.Icon).toBe(ChevronsUp)
    expect(priorityIconFor('P1')?.Icon).toBe(ChevronUp)
    expect(priorityIconFor('Major')?.Icon).toBe(ChevronUp)
    expect(priorityIconFor('P2')?.Icon).toBe(Equal)
    expect(priorityIconFor('P3')?.Icon).toBe(ChevronDown)
    expect(priorityIconFor('P4')?.Icon).toBe(ChevronsDown)
  })

  it('rises in colour with severity', () => {
    expect(priorityIconFor('Highest')?.className).toBe('text-danger')
    expect(priorityIconFor('High')?.className).toBe('text-danger')
    expect(priorityIconFor('Medium')?.className).toBe('text-defect')
    expect(priorityIconFor('Low')?.className).toBe('text-signal')
    expect(priorityIconFor('Lowest')?.className).toBe('text-signal')
  })

  // Unknown must stay distinguishable from "no priority": the card falls back to a text chip for
  // the former, so a custom scheme shows the word rather than disappearing.
  it('returns null for unset or unrecognised priorities', () => {
    expect(priorityIconFor(null)).toBeNull()
    expect(priorityIconFor('')).toBeNull()
    expect(priorityIconFor('Escalated')).toBeNull()
  })
})
