// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { WindowTitleBar } from '../WindowTitleBar'

describe('WindowTitleBar', () => {
  it('names the window and is a drag region inset past the system buttons', () => {
    render(<WindowTitleBar />)
    const bar = screen.getByText('Argus — Editor')
    // The window is frameless: this strip is the only thing left to drag it by.
    expect(bar.className).toContain('argus-drag')
    expect(bar.className).toContain('argus-titlebar-inset')
  })
})
