// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReadOnlyNotice } from '../ReadOnlyNotice'

describe('ReadOnlyNotice', () => {
  it('says why the asset is read-only', () => {
    render(<ReadOnlyNotice kind="skill" name="theirs" tier="hivemind" onEditCopy={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent(/read-only/i)
    // Reuses the shared explanation rather than inventing a second wording for the same fact.
    expect(screen.getByRole('status')).toHaveTextContent(/pinned to a commit/i)
  })

  it('offers Edit a copy', async () => {
    const onEditCopy = vi.fn()
    render(<ReadOnlyNotice kind="skill" name="theirs" tier="hivemind" onEditCopy={vi.fn()} />)
    expect(screen.getByRole('button', { name: /edit a copy/i })).toBeInTheDocument()
    render(
      <ReadOnlyNotice kind="reference" name="s.md" tier="confluence" onEditCopy={onEditCopy} />
    )
    await userEvent.click(screen.getAllByRole('button', { name: /edit a copy/i })[1])
    expect(onEditCopy).toHaveBeenCalled()
  })

  it('falls back to a plain sentence for an unknown tier', () => {
    render(
      <ReadOnlyNotice kind="reference" name="x.md" tier="something-new" onEditCopy={vi.fn()} />
    )
    expect(screen.getByRole('status')).toHaveTextContent(/read-only/i)
  })
})
