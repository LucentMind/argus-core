// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { HeaderRepos } from '../HeaderRepos'

beforeEach(() => {
  ;(window as unknown as { argus: unknown }).argus = {
    workspaces: {
      list: vi.fn().mockResolvedValue([]),
      refs: vi
        .fn()
        .mockResolvedValue([
          { remote: 'https://github.com/org/nav-sdk.git', branch: 'main', commit: 'abcdef1234567' }
        ]),
      pick: vi.fn(),
      link: vi.fn(),
      unlink: vi.fn()
    },
    graph: {
      status: vi.fn().mockResolvedValue([]),
      build: vi.fn(),
      install: vi.fn(),
      onBuilding: vi.fn(() => () => {}),
      onChanged: vi.fn(() => () => {})
    }
  }
})

describe('HeaderRepos unlinked refs', () => {
  it('renders imported workspace refs as unlinked chips', async () => {
    render(<HeaderRepos slug="NAV-100" />)
    expect(await screen.findByText(/nav-sdk @ abcdef1 · unlinked/)).toBeInTheDocument()
  })
})
