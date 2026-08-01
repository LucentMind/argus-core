import { describe, it, expect } from 'vitest'
import { optionsKeyOf } from '../registry'

describe('optionsKeyOf', () => {
  it('is stable for the same selection regardless of array order', () => {
    const a = optionsKeyOf(
      [
        { id: 'effort', value: 'max' },
        { id: 'thinking', value: true }
      ],
      'default'
    )
    const b = optionsKeyOf(
      [
        { id: 'thinking', value: true },
        { id: 'effort', value: 'max' }
      ],
      'default'
    )
    expect(a).toBe(b)
  })

  it('changes when a selection changes', () => {
    const a = optionsKeyOf([{ id: 'effort', value: 'max' }], 'default')
    const b = optionsKeyOf([{ id: 'effort', value: 'low' }], 'default')
    expect(a).not.toBe(b)
  })

  it('changes when only the permission mode changes', () => {
    expect(optionsKeyOf([], 'default')).not.toBe(optionsKeyOf([], 'acceptEdits'))
  })

  it('treats an empty selection and a null mode as one stable key', () => {
    expect(optionsKeyOf([], null)).toBe(optionsKeyOf([], null))
  })
})
