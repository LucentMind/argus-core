import { describe, it, expect } from 'vitest'
import { routineSchema, routinesFileSchema, defaultRoutines } from '../routines'

describe('routine schema', () => {
  it('applies defaults for timeoutMs and enabled', () => {
    const r = routineSchema.parse({ id: 'nightly-sweep', name: 'Nightly sweep', prompt: 'do it' })
    expect(r.timeoutMs).toBe(600_000)
    expect(r.enabled).toBe(true)
  })

  it('rejects ids that are not case-slug-safe', () => {
    expect(() => routineSchema.parse({ id: 'Has Spaces', name: 'x', prompt: 'y' })).toThrow()
  })

  it('parses an empty file to defaults', () => {
    expect(routinesFileSchema.parse({})).toEqual(defaultRoutines())
  })
})
