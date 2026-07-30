// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DiffView } from '../DiffView'

const kinds = (c: HTMLElement, kind: string): Element[] =>
  Array.from(c.querySelectorAll(`[data-kind="${kind}"]`))

describe('DiffView', () => {
  it('labels both sides', () => {
    render(<DiffView before={'a\n'} after={'a\n'} beforeLabel="On disk" afterLabel="Yours" />)
    expect(screen.getByText('On disk')).toBeInTheDocument()
    expect(screen.getByText('Yours')).toBeInTheDocument()
  })

  it('marks nothing added or removed for identical input', () => {
    const { container } = render(
      <DiffView before={'a\nb\n'} after={'a\nb\n'} beforeLabel="L" afterLabel="R" />
    )
    expect(kinds(container, 'add')).toHaveLength(0)
    expect(kinds(container, 'del')).toHaveLength(0)
    expect(kinds(container, 'same').length).toBeGreaterThan(0)
  })

  it('marks a changed line as one del and one add', () => {
    const { container } = render(
      <DiffView before={'a\nb\n'} after={'a\nB\n'} beforeLabel="L" afterLabel="R" />
    )
    expect(kinds(container, 'del').map((e) => e.textContent)).toEqual(['2b'])
    expect(kinds(container, 'add').map((e) => e.textContent)).toEqual(['2B'])
  })

  it('renders an insertion with an empty cell opposite it', () => {
    const { container } = render(
      <DiffView before={'a\n'} after={'a\nextra\n'} beforeLabel="L" afterLabel="R" />
    )
    expect(kinds(container, 'add').map((e) => e.textContent)).toEqual(['2extra'])
    expect(kinds(container, 'del')).toHaveLength(0)
  })

  it('renders a deletion with an empty cell opposite it', () => {
    const { container } = render(
      <DiffView before={'a\ngone\n'} after={'a\n'} beforeLabel="L" afterLabel="R" />
    )
    expect(kinds(container, 'del').map((e) => e.textContent)).toEqual(['2gone'])
    expect(kinds(container, 'add')).toHaveLength(0)
  })

  it('renders the caller-supplied actions', () => {
    render(
      <DiffView
        before="a"
        after="b"
        beforeLabel="L"
        afterLabel="R"
        actions={<button type="button">Keep mine</button>}
      />
    )
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument()
  })
})
