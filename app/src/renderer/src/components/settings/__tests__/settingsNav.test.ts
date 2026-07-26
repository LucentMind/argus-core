import { describe, it, expect } from 'vitest'
import { visiblePages } from '../settingsPages'

describe('visiblePages', () => {
  it('hides the Prompts page when devTools is off', () => {
    expect(visiblePages(false).some((p) => p.id === 'prompts')).toBe(false)
  })

  it('shows the Prompts page when devTools is on', () => {
    expect(visiblePages(true).some((p) => p.id === 'prompts')).toBe(true)
  })

  it('hides it rather than disabling it', () => {
    // `enabled: false` renders a greyed-out button, which would advertise the page's existence
    // in a production build. Absence is the requirement.
    const off = visiblePages(false)
    expect(off.find((p) => p.id === 'prompts')).toBeUndefined()
  })

  it('leaves every non-dev page visible in both states', () => {
    const off = visiblePages(false).map((p) => p.id)
    const on = visiblePages(true).map((p) => p.id)
    expect(on.filter((id) => id !== 'prompts')).toEqual(off)
  })
})
