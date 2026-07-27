// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import userEvent from '@testing-library/user-event'
import { PrPickerDialog } from '../PrPickerDialog'
import type { PrCandidate } from '../../../../shared/pr'

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

const link = vi.fn()

beforeEach(() => {
  link.mockReset().mockResolvedValue(undefined)
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
})
