// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { QuestionCard } from '../QuestionCard'

const single = {
  dialogId: 'd1',
  questions: [
    {
      question: 'Which log first?',
      header: 'Order',
      multiSelect: false,
      options: [
        { label: 'Crash log', description: 'the stack trace' },
        { label: 'Network log', description: 'the request timeline' }
      ]
    }
  ]
}
const multi = {
  dialogId: 'd2',
  questions: [
    {
      question: 'Which artifacts matter?',
      header: 'Scope',
      multiSelect: true,
      options: [
        { label: 'Logs', description: '' },
        { label: 'Screenshots', description: '' },
        { label: 'Network', description: '' }
      ]
    }
  ]
}

beforeEach(() => {
  window.argus = { agent: { answerDialog: vi.fn() } } as never
})

describe('QuestionCard', () => {
  it('shows header, question, options and descriptions', () => {
    render(<QuestionCard slug="NAV-1" sessionId={1} dialog={single} />)
    expect(screen.getByText('Order')).toBeInTheDocument()
    expect(screen.getByText('Which log first?')).toBeInTheDocument()
    expect(screen.getByText('Crash log')).toBeInTheDocument()
    expect(screen.getByText('the stack trace')).toBeInTheDocument()
  })

  it('Submit is disabled until every question is answered', () => {
    render(<QuestionCard slug="NAV-1" sessionId={1} dialog={single} />)
    const submit = screen.getByRole('button', { name: /submit/i })
    expect(submit).toBeDisabled()
    fireEvent.click(screen.getByText('Crash log'))
    expect(submit).not.toBeDisabled()
  })

  it('single-select Submit sends one answer keyed by question text', () => {
    render(<QuestionCard slug="NAV-1" sessionId={1} dialog={single} />)
    fireEvent.click(screen.getByText('Network log'))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(window.argus.agent.answerDialog).toHaveBeenCalledWith('NAV-1', 1, {
      dialogId: 'd1',
      behavior: 'completed',
      result: { answers: { 'Which log first?': 'Network log' } }
    })
  })

  it('multi-select comma-joins the picked labels', () => {
    render(<QuestionCard slug="NAV-1" sessionId={1} dialog={multi} />)
    fireEvent.click(screen.getByText('Logs'))
    fireEvent.click(screen.getByText('Network'))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(window.argus.agent.answerDialog).toHaveBeenCalledWith('NAV-1', 1, {
      dialogId: 'd2',
      behavior: 'completed',
      result: { answers: { 'Which artifacts matter?': 'Logs, Network' } }
    })
  })

  it('free-text alone satisfies a question and maps to both the answer and response', () => {
    render(<QuestionCard slug="NAV-1" sessionId={1} dialog={single} />)
    fireEvent.change(screen.getByPlaceholderText(/other/i), { target: { value: 'both, in parallel' } })
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(window.argus.agent.answerDialog).toHaveBeenCalledWith('NAV-1', 1, {
      dialogId: 'd1',
      behavior: 'completed',
      result: { answers: { 'Which log first?': 'both, in parallel' }, response: 'both, in parallel' }
    })
  })

  it('Skip sends cancelled', () => {
    render(<QuestionCard slug="NAV-1" sessionId={1} dialog={single} />)
    fireEvent.click(screen.getByRole('button', { name: /skip/i }))
    expect(window.argus.agent.answerDialog).toHaveBeenCalledWith('NAV-1', 1, {
      dialogId: 'd1',
      behavior: 'cancelled'
    })
  })
})
