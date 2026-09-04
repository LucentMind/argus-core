// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NewRunPopover } from '../NewRunPopover'

beforeEach(() => {
  window.argus = {
    cases: {
      list: vi.fn(async () => [
        { slug: 'a', title: 'Alpha', jiraKey: 'NAV-1' },
        { slug: 'b', title: 'Beta', jiraKey: null }
      ])
    },
    distill: {
      redistill: vi.fn(async (slug: string) => ({ id: 7, caseSlug: slug, state: 'queued' })),
      dryRun: vi.fn(async (slug: string) => ({
        id: 8,
        caseSlug: slug,
        state: 'queued',
        dryRun: true
      }))
    }
  } as never
})

describe('NewRunPopover', () => {
  it('starts a dry run with ignore-prior on by default', async () => {
    const user = userEvent.setup()
    const onStarted = vi.fn()
    render(<NewRunPopover inFlightSlugs={new Set()} onStarted={onStarted} onClose={() => {}} />)
    await user.type(screen.getByRole('searchbox', { name: 'Case' }), 'bet')
    await user.click(await screen.findByRole('option', { name: /Beta/ }))
    await user.click(screen.getByRole('radio', { name: 'Dry run' }))
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(window.argus.distill.dryRun).toHaveBeenCalledWith('b', true)
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 8 })))
  })
  it('a real run goes through redistill; unticking the checkbox passes false to a dry run', async () => {
    const user = userEvent.setup()
    render(
      <NewRunPopover
        fixedSlug="a"
        inFlightSlugs={new Set()}
        onStarted={() => {}}
        onClose={() => {}}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(window.argus.distill.redistill).toHaveBeenCalledWith('a')
    await user.click(screen.getByRole('radio', { name: 'Dry run' }))
    await user.click(screen.getByRole('checkbox', { name: "Ignore this case's prior proposals" }))
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(window.argus.distill.dryRun).toHaveBeenCalledWith('a', false)
  })
  it('is disabled with a tooltip while the case has a job in flight', async () => {
    render(
      <NewRunPopover
        fixedSlug="a"
        inFlightSlugs={new Set(['a'])}
        onStarted={() => {}}
        onClose={() => {}}
      />
    )
    const start = screen.getByRole('button', { name: 'Start' })
    expect(start).toBeDisabled()
    expect(start).toHaveAttribute('title', 'A distillation is already running for this case')
  })
  it('surfaces a refused enqueue inline', async () => {
    ;(window.argus.distill.dryRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('distill dry run for case a refused: case already has an in-flight job (3)')
    )
    const user = userEvent.setup()
    render(
      <NewRunPopover
        fixedSlug="a"
        inFlightSlugs={new Set()}
        onStarted={() => {}}
        onClose={() => {}}
      />
    )
    await user.click(screen.getByRole('radio', { name: 'Dry run' }))
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByText(/already has an in-flight job/)).toBeInTheDocument()
  })
  it('a double click before the first response starts one job', async () => {
    let resolve!: (v: unknown) => void
    ;(window.argus.distill.redistill as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((r) => (resolve = r))
    )
    render(
      <NewRunPopover
        fixedSlug="a"
        inFlightSlugs={new Set()}
        onStarted={() => {}}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(window.argus.distill.redistill).toHaveBeenCalledTimes(1)
    resolve({ id: 7 })
  })
})
