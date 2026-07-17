// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { HighlightedLines } from '../HighlightedLines'

describe('HighlightedLines', () => {
  it('renders plain numbered lines with focus highlight when lang is null', () => {
    const { container } = render(
      <HighlightedLines
        lines={['alpha', 'beta', 'gamma']}
        startLine={41}
        focusLine={42}
        lang={null}
        lineIdPrefix="line-"
      />
    )
    const focus = container.querySelector('#line-42')
    expect(focus).not.toBeNull()
    expect(focus!.className).toContain('bg-defect/20')
    expect(focus!.textContent).toContain('42')
    expect(focus!.textContent).toContain('beta')
    expect(container.querySelectorAll('pre div').length).toBe(3)
    expect(container.querySelector('[class*="hljs"]')).toBeNull()
  })

  it('applies hljs token spans once the language chunk loads', async () => {
    const { container } = render(
      <HighlightedLines lines={['const x = 1']} startLine={1} focusLine={null} lang="typescript" />
    )
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull())
    expect(container.querySelector('.hljs-keyword')!.textContent).toBe('const')
  })

  it('falls back to plain text for an unknown language id', () => {
    const { container } = render(
      <HighlightedLines lines={['whatever']} startLine={1} focusLine={null} lang="no-such-lang" />
    )
    expect(container.textContent).toContain('whatever')
  })
})
