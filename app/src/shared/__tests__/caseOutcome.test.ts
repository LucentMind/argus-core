import { describe, it, expect } from 'vitest'
import { deriveCaseOutcome } from '../caseOutcome'

const rc = [{ reviewState: 'accepted', role: 'root-cause' }]
const none: { reviewState: string; role: string | null }[] = []

describe('deriveCaseOutcome', () => {
  it('solved with an accepted root-cause finding is solved', () => {
    expect(deriveCaseOutcome({ status: 'closed', resolution: 'solved' }, rc)).toBe('solved')
  })
  it('solved without one is solved-unconfirmed (pending or rejected root-cause does not count)', () => {
    expect(deriveCaseOutcome({ status: 'closed', resolution: 'solved' }, none)).toBe(
      'solved-unconfirmed'
    )
    expect(
      deriveCaseOutcome({ status: 'closed', resolution: 'solved' }, [
        { reviewState: 'pending', role: 'root-cause' },
        { reviewState: 'rejected', role: 'root-cause' }
      ])
    ).toBe('solved-unconfirmed')
  })
  it.each([['not-reproducible'], ['wont-fix']])('%s is closed-unresolved', (r) => {
    expect(deriveCaseOutcome({ status: 'closed', resolution: r as never }, rc)).toBe(
      'closed-unresolved'
    )
  })
  it.each([['forwarded'], ['duplicate']])('%s is handed-off', (r) => {
    expect(deriveCaseOutcome({ status: 'closed', resolution: r as never }, rc)).toBe('handed-off')
  })
  it('rejected is rejected', () => {
    expect(deriveCaseOutcome({ status: 'closed', resolution: 'rejected' }, rc)).toBe('rejected')
  })
  it('an open case, or a closed one with no resolution, is open', () => {
    expect(deriveCaseOutcome({ status: 'open', resolution: null }, rc)).toBe('open')
    expect(deriveCaseOutcome({ status: 'closed', resolution: null }, rc)).toBe('open')
  })
})
