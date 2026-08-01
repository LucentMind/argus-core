// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { CommandPalette } from '../CommandPalette'
import { __resetEscapeLayersForTest } from '../../../lib/escapeLayer'
import type { AssetRow } from '../../../lib/palette'
import type { Command } from '../../../lib/commands'

const ASSETS: AssetRow[] = [
  {
    id: 'skill:triage',
    kind: 'skill',
    name: 'triage',
    title: '',
    description: 'Triage a case',
    tier: 'user'
  },
  {
    id: 'reference:jira-fields.md',
    kind: 'reference',
    name: 'jira-fields.md',
    title: 'Jira fields',
    description: '',
    tier: 'hivemind'
  },
  {
    id: 'draft:d1',
    kind: 'draft',
    name: 'half-written',
    title: '',
    description: '',
    tier: null,
    draft: { draftId: 'd1', kind: 'skill', mode: 'create', updatedAt: '2026-07-30T10:00:00.000Z' }
  }
]

const run = vi.fn()
const COMMANDS: Command[] = [
  { id: 'save', title: 'Save', section: 'File', keybinding: 'Ctrl+S', enabled: true, run },
  {
    id: 'saveAll',
    title: 'Save all',
    section: 'File',
    keybinding: 'Ctrl+Alt+S',
    enabled: false,
    run
  }
]

function Harness(
  props: { initial?: string } & Partial<React.ComponentProps<typeof CommandPalette>>
): React.JSX.Element {
  const [raw, setRaw] = useState(props.initial ?? '')
  return (
    <CommandPalette
      raw={raw}
      onRawChange={setRaw}
      commands={COMMANDS}
      assets={ASSETS}
      onPickAsset={props.onPickAsset ?? vi.fn()}
      onDiscardDraft={props.onDiscardDraft ?? vi.fn()}
      onClose={props.onClose ?? vi.fn()}
    />
  )
}

const input = (): HTMLInputElement => screen.getByRole('combobox')
const options = (): HTMLElement[] => screen.getAllByRole('option')

beforeEach(() => {
  __resetEscapeLayersForTest()
  run.mockClear()
})

describe('CommandPalette · assets mode', () => {
  it('lists every asset and focuses the field', () => {
    render(<Harness />)
    expect(options()).toHaveLength(3)
    expect(document.activeElement).toBe(input())
  })

  it('the palette card opts out of the window drag region', () => {
    // The editor window's TitleBarStrip is 40px of drag region; the palette opens at `pt-[12vh]`,
    // so its field lands inside that band whenever the window is under ~333px tall. Rarer than
    // ModalShell's version of this bug, but the same one — and here the swallowed control is the
    // only control there is. Chromium subtracts a no-drag rect; z-order does not.
    render(<Harness />)
    expect(screen.getByRole('dialog').className).toContain('argus-nodrag')
  })

  it('shows a tier badge, because opening a protected asset must not be a surprise', () => {
    render(<Harness />)
    expect(within(options()[1]!).getByText('HiveMind')).toBeTruthy()
  })

  it('heads the draft rows with a Drafts section', () => {
    render(<Harness />)
    expect(screen.getByText('Drafts')).toBeTruthy()
  })

  it('filters as you type', () => {
    render(<Harness />)
    fireEvent.change(input(), { target: { value: 'jira' } })
    expect(options()).toHaveLength(1)
    expect(options()[0]!.textContent).toContain('jira-fields.md')
  })

  it('says so when nothing matches', () => {
    render(<Harness />)
    fireEvent.change(input(), { target: { value: 'zzzz' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/no matching assets/i)).toBeTruthy()
  })

  it('picks the highlighted row on Enter', () => {
    const onPickAsset = vi.fn()
    render(<Harness onPickAsset={onPickAsset} />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onPickAsset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'reference:jira-fields.md' })
    )
  })

  it('picks on click', () => {
    const onPickAsset = vi.fn()
    render(<Harness onPickAsset={onPickAsset} />)
    fireEvent.click(options()[0]!)
    expect(onPickAsset).toHaveBeenCalledWith(expect.objectContaining({ id: 'skill:triage' }))
  })

  it('wraps the highlight at both ends', () => {
    render(<Harness />)
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
  })

  it('re-highlights the first row when the query changes', () => {
    render(<Harness />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.change(input(), { target: { value: 'j' } })
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
  })

  it('points aria-activedescendant at the highlighted option', () => {
    render(<Harness />)
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id)
  })

  it('discards a draft from its own row', () => {
    const onDiscardDraft = vi.fn()
    render(<Harness onDiscardDraft={onDiscardDraft} />)
    fireEvent.click(within(options()[2]!).getByRole('button', { name: /discard/i }))
    expect(onDiscardDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft:d1' }))
  })

  it('discards the highlighted draft on Delete, and does nothing on a non-draft row', () => {
    const onDiscardDraft = vi.fn()
    render(<Harness onDiscardDraft={onDiscardDraft} />)
    fireEvent.keyDown(input(), { key: 'Delete' })
    expect(onDiscardDraft).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    fireEvent.keyDown(input(), { key: 'Delete' })
    expect(onDiscardDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft:d1' }))
  })

  it('does not close when a discard button is clicked', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.click(within(options()[2]!).getByRole('button', { name: /discard/i }))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('CommandPalette · commands mode', () => {
  it('switches on a leading > and lists commands with their chords', () => {
    render(<Harness initial=">" />)
    expect(options()).toHaveLength(2)
    expect(within(options()[0]!).getByText('Ctrl+S')).toBeTruthy()
  })

  it('runs the picked command', () => {
    render(<Harness initial=">" />)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('shows a disabled command but will not run it', () => {
    render(<Harness initial=">" />)
    expect(options()[1]!.getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(run).not.toHaveBeenCalled()
  })

  it('closes after running a command', () => {
    const onClose = vi.fn()
    render(<Harness initial=">" onClose={onClose} />)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('switches back to assets when the > is deleted', () => {
    render(<Harness initial=">" />)
    fireEvent.change(input(), { target: { value: '' } })
    expect(options()).toHaveLength(3)
  })
})

describe('CommandPalette · dismissal', () => {
  it('clears the query on the first Escape and closes on the second', () => {
    const onClose = vi.fn()
    render(<Harness initial="jira" onClose={onClose} />)
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(input().value).toBe('')
    expect(onClose).not.toHaveBeenCalled()
    // The field blurs on the empty Escape, which is what lets the layer see the next one.
    fireEvent.keyDown(input(), { key: 'Escape' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on a click outside, but not on a click inside', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.mouseDown(screen.getByTestId('palette-backdrop'))
    expect(onClose).toHaveBeenCalledOnce()
    onClose.mockClear()
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
