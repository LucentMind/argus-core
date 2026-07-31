// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { AmbientCanvas } from '../AmbientCanvas'

describe('AmbientCanvas', () => {
  // jsdom has no WebGL: getContext('webgl2') returns null (or throws in some
  // configs). This test doubles as the real-world no-WebGL fallback check.
  it('renders the CSS fallback and does not throw when WebGL is unavailable', () => {
    const { getByTestId, queryByTestId } = render(
      <AmbientCanvas light={null} cutoff={null} theme="dark" />
    )
    expect(getByTestId('ambient-fallback')).toBeTruthy()
    expect(queryByTestId('ambient-canvas')).toBeNull()
  })

  it('fallback is inert decoration: aria-hidden, pointer-events handled by CSS', () => {
    const { getByTestId } = render(<AmbientCanvas light={null} cutoff={null} theme="light" />)
    expect(getByTestId('ambient-fallback').getAttribute('aria-hidden')).toBe('true')
  })
})
