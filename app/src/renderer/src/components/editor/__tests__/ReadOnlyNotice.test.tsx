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

  // The name is IN the sentence, not a `title` tooltip on it. Several read-only tabs stay mounted
  // at once, and the banners were otherwise byte-identical; a tooltip on a truncated sentence also
  // reveals the asset name rather than the text actually elided.
  it('names the asset in the sentence rather than in a tooltip', () => {
    render(<ReadOnlyNotice kind="skill" name="theirs" tier="hivemind" onEditCopy={vi.fn()} />)
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent(/theirs/)
    expect(notice.querySelector('[title]')).toBeNull()
  })

  it('offers Edit a copy for a hivemind skill and a hivemind reference', async () => {
    const onEditCopy = vi.fn()
    render(<ReadOnlyNotice kind="skill" name="theirs" tier="hivemind" onEditCopy={vi.fn()} />)
    expect(screen.getByRole('button', { name: /edit a copy/i })).toBeInTheDocument()
    render(<ReadOnlyNotice kind="reference" name="s.md" tier="hivemind" onEditCopy={onEditCopy} />)
    await userEvent.click(screen.getAllByRole('button', { name: /edit a copy/i })[1])
    expect(onEditCopy).toHaveBeenCalled()
  })

  // `claimReference` (hivemind.ts:568) accepts only an installed HiveMind reference, so the button
  // here fired an IPC that always rejects. The tier's own explanation stands alone instead.
  it('offers no Edit a copy for a confluence reference', () => {
    render(<ReadOnlyNotice kind="reference" name="s.md" tier="confluence" onEditCopy={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent(/rebuilt from its confluence page/i)
    expect(screen.queryByRole('button', { name: /edit a copy/i })).not.toBeInTheDocument()
  })

  it('offers no Edit a copy for a bundled reference', () => {
    render(<ReadOnlyNotice kind="reference" name="s.md" tier="bundled" onEditCopy={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent(/ships with an installed pack/i)
    expect(screen.queryByRole('button', { name: /edit a copy/i })).not.toBeInTheDocument()
  })

  // A bundled SKILL is different from a bundled reference: `forkSkill` copies it into skills-user.
  it('offers Edit a copy for a bundled skill', () => {
    render(<ReadOnlyNotice kind="skill" name="packed" tier="bundled" onEditCopy={vi.fn()} />)
    expect(screen.getByRole('button', { name: /edit a copy/i })).toBeInTheDocument()
  })

  it('falls back to a plain sentence for an unknown tier', () => {
    render(
      <ReadOnlyNotice kind="reference" name="x.md" tier="something-new" onEditCopy={vi.fn()} />
    )
    expect(screen.getByRole('status')).toHaveTextContent(/read-only/i)
  })
})
