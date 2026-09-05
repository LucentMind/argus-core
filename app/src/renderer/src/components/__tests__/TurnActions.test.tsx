// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TurnActions } from '../TurnActions'

describe('TurnActions', () => {
  it('opens the menu and lists both actions', () => {
    render(
      <TurnActions turnId={3} canRewind disabledReason={null} onRewind={vi.fn()} onFork={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'turn actions' }))
    expect(screen.getByRole('menuitem', { name: 'Rewind to here' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Fork from here' })).toBeTruthy()
  })

  it('disables Rewind to here with a title when canRewind is false', () => {
    render(
      <TurnActions
        turnId={3}
        canRewind={false}
        disabledReason={null}
        onRewind={vi.fn()}
        onFork={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'turn actions' }))
    const rewind = screen.getByRole('menuitem', { name: 'Rewind to here' })
    expect(rewind).toBeDisabled()
  })

  it('disables both actions with disabledReason as the title when a turn is running', () => {
    render(
      <TurnActions
        turnId={3}
        canRewind
        disabledReason="A turn is running"
        onRewind={vi.fn()}
        onFork={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'turn actions' }))
    const rewind = screen.getByRole('menuitem', { name: 'Rewind to here' })
    const fork = screen.getByRole('menuitem', { name: 'Fork from here' })
    expect(rewind).toBeDisabled()
    expect(rewind).toHaveAttribute('title', 'A turn is running')
    expect(fork).toBeDisabled()
    expect(fork).toHaveAttribute('title', 'A turn is running')
  })

  it('calls onRewind and onFork with the turnId when clicked', () => {
    const onRewind = vi.fn()
    const onFork = vi.fn()
    render(
      <TurnActions turnId={7} canRewind disabledReason={null} onRewind={onRewind} onFork={onFork} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'turn actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewind to here' }))
    expect(onRewind).toHaveBeenCalledWith(7)

    fireEvent.click(screen.getByRole('button', { name: 'turn actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork from here' }))
    expect(onFork).toHaveBeenCalledWith(7)
  })
})
