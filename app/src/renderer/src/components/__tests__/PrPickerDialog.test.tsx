// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import userEvent from '@testing-library/user-event'
import { PrPickerDialog } from '../PrPickerDialog'
import type { PrCandidate } from '../../../../shared/pr'

const cand = (o: Partial<PrCandidate> & Pick<PrCandidate, 'number'>): PrCandidate => ({
  owner: 'vendor',
  repo: 'vendor-sdk',
  url: `https://github.com/vendor/vendor-sdk/pull/${o.number}`,
  title: `[NN-5165] change ${o.number}`,
  state: 'merged',
  isDraft: false,
  createdAt: '2026-07-21T10:00:00Z',
  isBackport: false,
  preselected: true,
  ...o
})

const linkMany = vi.fn()

beforeEach(() => {
  linkMany.mockReset().mockResolvedValue([])
  ;(window as unknown as { argus: unknown }).argus = {
    pr: { linkMany }
  } as never
})

describe('PrPickerDialog', () => {
  it('checks preselected candidates and leaves backports unchecked', () => {
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
          searchedRepos: ['vendor/vendor-sdk']
        }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('checkbox', { name: /16315/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /16395/ })).not.toBeChecked()
  })

  it('links exactly the checked candidates on confirm', async () => {
    const onClose = vi.fn()
    render(
      <PrPickerDialog
        slug="c1"
        result={{
          candidates: [cand({ number: 16315 }), cand({ number: 16395, preselected: false })],
          error: null,
          searchedRepos: ['vendor/vendor-sdk']
        }}
        onClose={onClose}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /link selected/i }))
    await waitFor(() => expect(linkMany).toHaveBeenCalledTimes(1))
    expect(linkMany).toHaveBeenCalledWith('c1', [expect.objectContaining({ number: 16315 })])
    expect(onClose).toHaveBeenCalled()
  })

  it('names the searched repos when nothing was found', () => {
    render(
      <PrPickerDialog
        slug="c1"
        result={{ candidates: [], error: null, searchedRepos: ['vendor/vendor-sdk'] }}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(/vendor\/vendor-sdk/)).toBeInTheDocument()
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
