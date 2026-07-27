// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import userEvent from '@testing-library/user-event'
import { PrPickerDialog } from '../PrPickerDialog'
import { confirm } from '../../lib/confirmStore'
import type { PrBinding, PrCandidate } from '../../../../shared/pr'

vi.mock('../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

const cand = (o: Partial<PrCandidate> & Pick<PrCandidate, 'number'>): PrCandidate => ({
  owner: 'JiaweiHan88',
  repo: 'HiveMindTest',
  url: `https://github.com/JiaweiHan88/HiveMindTest/pull/${o.number}`,
  title: `[NN-5165] change ${o.number}`,
  state: 'merged',
  isDraft: false,
  createdAt: '2026-07-21T10:00:00Z',
  isBackport: false,
  preselected: true,
  ...o
})

const BOUND: PrBinding = {
  id: 9,
  caseId: 1,
  repoPath: 'C:\\repos\\HiveMindTest',
  owner: 'JiaweiHan88',
  repo: 'HiveMindTest',
  number: 16315,
  url: 'https://github.com/JiaweiHan88/HiveMindTest/pull/16315',
  source: 'search',
  detectedAt: '2026-07-20T10:00:00Z'
}

const link = vi.fn()

beforeEach(() => {
  link.mockReset().mockResolvedValue(undefined)
  vi.mocked(confirm).mockReset().mockResolvedValue(true)
  ;(window as unknown as { argus: unknown }).argus = {
    pr: { link }
  } as never
})

describe('PrPickerDialog', () => {
  it('preselects the first non-backport candidate and leaves the backport unselected', () => {
    render(
      <PrPickerDialog
        slug="c1"
        result={{
          candidates: [
            cand({ number: 16315 }),
            cand({
              number: 16395,
              isBackport: true,
              preselected: false,
              title: '[Backport release/v0.27] [NN-5165] x'
            })
          ],
          error: null,
          searchedRepos: ['JiaweiHan88/HiveMindTest']
        }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('radio', { name: /16315/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /16395/ })).not.toBeChecked()
  })

  it('selects nothing and disables Link selected when every hit is a backport', async () => {
    // This is the one scenario the whole one-PR-per-case branch exists for: a PR and its
    // backport turning up together. Pre-selecting `candidates[0]` here (the old "never
    // confirmable-but-empty" fallback) would silently default the picker onto a backport —
    // fixed by selecting nothing and disabling confirm instead, which meets the original
    // worry (nothing can be confirmed while empty) without ever choosing a backport.
    render(
      <PrPickerDialog
        slug="c1"
        result={{
          candidates: [
            cand({
              number: 16315,
              isBackport: true,
              preselected: false,
              title: '[Backport release/v0.27] a'
            }),
            cand({
              number: 16395,
              isBackport: true,
              preselected: false,
              title: '[Backport release/v0.27] b'
            })
          ],
          error: null,
          searchedRepos: ['JiaweiHan88/HiveMindTest']
        }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('radio', { name: /16315/ })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /16395/ })).not.toBeChecked()
    expect(screen.getByRole('button', { name: /link selected/i })).toBeDisabled()

    // picking one enables it again, and links exactly that candidate
    await userEvent.click(screen.getByRole('radio', { name: /16395/ }))
    expect(screen.getByRole('button', { name: /link selected/i })).not.toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /link selected/i }))
    await waitFor(() => expect(link).toHaveBeenCalledTimes(1))
    expect(link).toHaveBeenCalledWith('c1', expect.objectContaining({ number: 16395 }))
  })

  it('only one candidate is selectable at a time', async () => {
    render(
      <PrPickerDialog
        slug="c1"
        result={{
          candidates: [cand({ number: 16315 }), cand({ number: 16395, preselected: false })],
          error: null,
          searchedRepos: ['JiaweiHan88/HiveMindTest']
        }}
        onClose={vi.fn()}
      />
    )
    const first = screen.getByRole('radio', { name: /16315/ })
    const second = screen.getByRole('radio', { name: /16395/ })
    expect(first).toBeChecked()
    expect(second).not.toBeChecked()

    await userEvent.click(second)
    expect(second).toBeChecked()
    expect(first).not.toBeChecked()
  })

  it('links exactly the selected candidate on confirm', async () => {
    const onClose = vi.fn()
    render(
      <PrPickerDialog
        slug="c1"
        result={{
          candidates: [cand({ number: 16315 }), cand({ number: 16395, preselected: false })],
          error: null,
          searchedRepos: ['JiaweiHan88/HiveMindTest']
        }}
        onClose={onClose}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /link selected/i }))
    await waitFor(() => expect(link).toHaveBeenCalledTimes(1))
    expect(link).toHaveBeenCalledWith('c1', {
      owner: 'JiaweiHan88',
      repo: 'HiveMindTest',
      number: 16315,
      url: 'https://github.com/JiaweiHan88/HiveMindTest/pull/16315'
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('links the newly selected candidate, not the original default, after switching', async () => {
    const onClose = vi.fn()
    render(
      <PrPickerDialog
        slug="c1"
        result={{
          candidates: [cand({ number: 16315 }), cand({ number: 16395, preselected: false })],
          error: null,
          searchedRepos: ['JiaweiHan88/HiveMindTest']
        }}
        onClose={onClose}
      />
    )
    await userEvent.click(screen.getByRole('radio', { name: /16395/ }))
    await userEvent.click(screen.getByRole('button', { name: /link selected/i }))
    await waitFor(() => expect(link).toHaveBeenCalledTimes(1))
    expect(link).toHaveBeenCalledWith('c1', expect.objectContaining({ number: 16395 }))
    expect(onClose).toHaveBeenCalled()
  })

  it('names the searched repos when nothing was found', () => {
    render(
      <PrPickerDialog
        slug="c1"
        result={{ candidates: [], error: null, searchedRepos: ['JiaweiHan88/HiveMindTest'] }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(/JiaweiHan88\/HiveMindTest/)).toBeInTheDocument()
  })

  it('shows the search error and still offers manual linking', () => {
    render(
      <PrPickerDialog
        slug="c1"
        result={{ candidates: [], error: 'GitHub CLI (gh) is not installed', searchedRepos: [] }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(/not installed/i)).toBeInTheDocument()
  })

  // Re-review fix: the picker is reachable ("Find PRs") whether or not a PR is already
  // bound — it is, in fact, the only way to re-open it once something is bound. Selecting a
  // DIFFERENT candidate there used to replace the binding with no warning, same hazard the
  // manual Repos-rail link already guards against.
  describe('replacing an already-bound PR from the picker', () => {
    const result = {
      candidates: [cand({ number: 16315 }), cand({ number: 16395, preselected: false })],
      error: null,
      searchedRepos: ['JiaweiHan88/HiveMindTest']
    }

    it('marks the already-bound candidate in the list', () => {
      render(<PrPickerDialog slug="c1" result={result} currentBinding={BOUND} onClose={vi.fn()} />)
      const boundRow = screen.getByRole('radio', { name: /16315/ }).closest('label')
      const otherRow = screen.getByRole('radio', { name: /16395/ }).closest('label')
      expect(boundRow).toHaveTextContent(/linked/i)
      expect(otherRow).not.toHaveTextContent(/linked/i)
    })

    it('raises a confirm naming both PRs when a different candidate is selected', async () => {
      render(<PrPickerDialog slug="c1" result={result} currentBinding={BOUND} onClose={vi.fn()} />)
      await userEvent.click(screen.getByRole('radio', { name: /16395/ }))
      await userEvent.click(screen.getByRole('button', { name: /link selected/i }))
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      const title = vi.mocked(confirm).mock.calls[0][0].title as string
      expect(title).toContain('JiaweiHan88/HiveMindTest#16315')
      expect(title).toContain('JiaweiHan88/HiveMindTest#16395')
    })

    it('declining leaves the binding untouched and calls no IPC', async () => {
      vi.mocked(confirm).mockResolvedValue(false)
      const onClose = vi.fn()
      render(<PrPickerDialog slug="c1" result={result} currentBinding={BOUND} onClose={onClose} />)
      await userEvent.click(screen.getByRole('radio', { name: /16395/ }))
      await userEvent.click(screen.getByRole('button', { name: /link selected/i }))
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      await new Promise((r) => setTimeout(r, 0))
      expect(link).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('accepting proceeds to link the newly selected candidate', async () => {
      const onClose = vi.fn()
      render(<PrPickerDialog slug="c1" result={result} currentBinding={BOUND} onClose={onClose} />)
      await userEvent.click(screen.getByRole('radio', { name: /16395/ }))
      await userEvent.click(screen.getByRole('button', { name: /link selected/i }))
      await waitFor(() =>
        expect(link).toHaveBeenCalledWith('c1', expect.objectContaining({ number: 16395 }))
      )
      expect(onClose).toHaveBeenCalled()
    })

    it('does not confirm when selecting the candidate that is already bound', async () => {
      render(<PrPickerDialog slug="c1" result={result} currentBinding={BOUND} onClose={vi.fn()} />)
      // 16315 is already selected by default (preselected) AND is the current binding
      await userEvent.click(screen.getByRole('button', { name: /link selected/i }))
      await waitFor(() => expect(link).toHaveBeenCalledTimes(1))
      expect(confirm).not.toHaveBeenCalled()
    })

    it('does not confirm when nothing is currently bound', async () => {
      render(<PrPickerDialog slug="c1" result={result} onClose={vi.fn()} />)
      await userEvent.click(screen.getByRole('radio', { name: /16395/ }))
      await userEvent.click(screen.getByRole('button', { name: /link selected/i }))
      await waitFor(() => expect(link).toHaveBeenCalledTimes(1))
      expect(confirm).not.toHaveBeenCalled()
    })
  })
})
