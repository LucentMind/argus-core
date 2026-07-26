import { describe, it, expect } from 'vitest'
import { buildPromptPreview } from '../preview'
import { MODES } from '../../../../shared/modes'
import { NEUTRAL_PERSONA, DIAGRAM_FRAGMENT, CONTRIBUTE_BACK_NUDGE } from '../../agent/persona'

const resolve = (id: string): string => {
  const map: Record<string, string> = {
    'persona.mode.investigation': MODES.investigation.personaFragment,
    'persona.mode.review': MODES.review.personaFragment,
    'persona.neutral': NEUTRAL_PERSONA,
    'persona.diagram': DIAGRAM_FRAGMENT,
    'persona.contribute-back': CONTRIBUTE_BACK_NUDGE
  }
  const v = map[id]
  if (v === undefined) throw new Error(`unexpected id ${id}`)
  return v
}

describe('buildPromptPreview', () => {
  it('composes the investigation persona in assembleMode order', () => {
    const p = buildPromptPreview({ mode: 'investigation', resolve })
    expect(p.mode).toBe('investigation')
    expect(p.text.startsWith(MODES.investigation.personaFragment)).toBe(true)
    expect(p.text).toContain(NEUTRAL_PERSONA)
    expect(p.text).toContain(DIAGRAM_FRAGMENT)
    expect(p.fragments.map((f) => f.id)).toEqual([
      'persona.mode.investigation',
      'persona.neutral',
      'persona.diagram'
    ])
  })

  it('uses the review identity in review mode', () => {
    const p = buildPromptPreview({ mode: 'review', resolve })
    expect(p.fragments[0].id).toBe('persona.mode.review')
    expect(p.text.startsWith(MODES.review.personaFragment)).toBe(true)
  })

  it('fragment offsets slice the exact fragment text out of the composed string', () => {
    // The whole point of offsets: the UI highlights boundaries by slicing. If these drift the
    // UI silently mislabels which rule came from where.
    const p = buildPromptPreview({
      mode: 'investigation',
      resolve,
      packFragments: ['PACKTEXT'],
      personaAppend: 'MY APPEND'
    })
    expect(p.fragments.length).toBeGreaterThan(0)
    for (const f of p.fragments) {
      const slice = p.text.slice(f.start, f.end)
      expect(slice.length, f.label).toBeGreaterThan(0)
      // Registry-owned fragments must equal exactly what resolve() returned. Non-registry
      // fragments (id === null) are asserted against their known inputs rather than against
      // themselves — `slice === slice` would pass no matter how wrong the offsets were.
      if (f.id) expect(slice, f.label).toBe(resolve(f.id).trim())
      else expect(['PACKTEXT', 'MY APPEND'], f.label).toContain(slice)
    }
    // Offsets must be non-overlapping and ascending, or two fragments claim the same bytes.
    for (let i = 1; i < p.fragments.length; i++) {
      expect(p.fragments[i].start).toBeGreaterThanOrEqual(p.fragments[i - 1].end)
    }
  })

  it('includes pack fragments verbatim, marked with a null id', () => {
    const p = buildPromptPreview({ mode: 'investigation', resolve, packFragments: ['PACKTEXT'] })
    const pack = p.fragments.find((f) => f.id === null)
    expect(pack).toBeDefined()
    expect(p.text.slice(pack!.start, pack!.end)).toBe('PACKTEXT')
    expect(pack!.label).toMatch(/pack/i)
  })

  it('includes the contribute-back nudge only when enabled', () => {
    const off = buildPromptPreview({ mode: 'investigation', resolve })
    const on = buildPromptPreview({ mode: 'investigation', resolve, contributeBack: true })
    expect(off.fragments.some((f) => f.id === 'persona.contribute-back')).toBe(false)
    expect(on.fragments.some((f) => f.id === 'persona.contribute-back')).toBe(true)
  })

  it('appends personaAppend last, marked as not registry-owned', () => {
    const p = buildPromptPreview({ mode: 'investigation', resolve, personaAppend: 'MY APPEND' })
    const last = p.fragments[p.fragments.length - 1]
    expect(last.id).toBeNull()
    expect(p.text.slice(last.start, last.end)).toBe('MY APPEND')
    expect(p.text.endsWith('MY APPEND')).toBe(true)
  })

  it('declares the per-session blocks it omits', () => {
    const p = buildPromptPreview({ mode: 'investigation', resolve })
    expect(p.omits.length).toBeGreaterThan(0)
    expect(p.omits.join(' ')).toMatch(/memory/i)
    expect(p.omits.join(' ')).toMatch(/skill/i)
  })

  it('rejects an unknown mode with a useful message', () => {
    // This is reached from an IPC handler, whose arguments are untyped at runtime — typecheck
    // cannot police that boundary. Without this guard MODES[mode] is undefined and the failure
    // surfaces deep inside assembleMode as an unreadable property access.
    expect(() => buildPromptPreview({ mode: 'nope' as never, resolve })).toThrow(/unknown mode/i)
  })
})
