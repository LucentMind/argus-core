// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PrFaceIcon } from '../PrRollupDot'
import type { PrStatus } from '../../../../shared/prStatus'

const BASE: PrStatus = {
  owner: 'o',
  repo: 'r',
  number: 7,
  url: 'https://example.test/pr/7',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  rollup: 'passing',
  checks: [],
  fetchedAt: '2026-08-01T10:00:00.000Z',
  error: null
}

describe('PrFaceIcon', () => {
  it('names the PR and its state accessibly', () => {
    render(<PrFaceIcon status={BASE} />)
    expect(screen.getByRole('img', { name: /PR #7/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /checks passing/i })).toBeInTheDocument()
  })

  it('colours each state from the theme tokens', () => {
    const cases: Array<[Partial<PrStatus>, string]> = [
      [{ state: 'MERGED' }, 'text-analytics'],
      [{ mergeable: 'CONFLICTING' }, 'text-defect'],
      [{ rollup: 'failing' }, 'text-danger'],
      [{ rollup: 'passing' }, 'text-review'],
      [{ isDraft: true }, 'text-mute']
    ]
    for (const [patch, cls] of cases) {
      const { unmount } = render(<PrFaceIcon status={{ ...BASE, ...patch }} />)
      expect(screen.getByRole('img').className).toContain(cls)
      unmount()
    }
  })

  it('pulses only while checks are running', () => {
    const { unmount } = render(<PrFaceIcon status={{ ...BASE, rollup: 'running' }} />)
    expect(screen.getByRole('img').className).toContain('animate-pulse')
    unmount()
    render(<PrFaceIcon status={BASE} />)
    expect(screen.getByRole('img').className).not.toContain('animate-pulse')
  })
})
