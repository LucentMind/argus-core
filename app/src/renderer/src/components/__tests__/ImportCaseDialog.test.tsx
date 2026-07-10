// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ImportCaseDialog } from '../ImportCaseDialog'
import type { BundleInspection } from '../../../../shared/bundle'

const inspection: BundleInspection = {
  zipPath: 'C:/tmp/NAV-100.arguscase',
  proposedSlug: 'NAV-100-2',
  collision: true,
  manifest: {
    format: 1,
    slug: 'NAV-100',
    title: 'Tile region fails',
    argusVersion: '1.0.0',
    createdAt: '2026-07-10T00:00:00.000Z',
    includesTranscripts: true,
    workspaces: [{ remote: 'https://github.com/org/repo.git', branch: 'main', commit: 'abc' }],
    files: [{ path: 'case.json', sha256: 'x', size: 1 }]
  }
}

beforeEach(() => {
  ;(window as unknown as { argus: unknown }).argus = {
    bundle: { import: vi.fn().mockResolvedValue({ ok: true, record: { slug: 'NAV-100-2' } }) }
  }
})

describe('ImportCaseDialog', () => {
  it('shows the summary incl. the renamed-slug note and imports on confirm', async () => {
    const onImported = vi.fn()
    render(
      <ImportCaseDialog state={{ inspection }} onClose={() => undefined} onImported={onImported} />
    )
    expect(screen.getByText('Tile region fails')).toBeInTheDocument()
    expect(screen.getByText(/NAV-100 already exists/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Import as NAV-100-2/ }))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('NAV-100-2'))
  })

  it('renders an inspect error state with no confirm button', () => {
    render(
      <ImportCaseDialog
        state={{ error: 'Not an Argus case bundle: manifest.json missing' }}
        onClose={() => undefined}
        onImported={() => undefined}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/manifest\.json missing/)
    expect(screen.queryByRole('button', { name: /Import as/ })).toBeNull()
  })

  it('surfaces an import failure inline', async () => {
    ;(
      window as unknown as {
        argus: { bundle: { import: ReturnType<typeof vi.fn> } }
      }
    ).argus.bundle.import.mockResolvedValue({ ok: false, error: 'checksum mismatch on x' })
    render(
      <ImportCaseDialog
        state={{ inspection }}
        onClose={() => undefined}
        onImported={() => undefined}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Import as NAV-100-2/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/checksum mismatch/))
  })
})
