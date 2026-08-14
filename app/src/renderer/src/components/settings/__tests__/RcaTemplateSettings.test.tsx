// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RcaTemplateSettings } from '../RcaTemplateSettings'
import { DEFAULT_RCA_TEMPLATE } from '../../../../../shared/rcaTemplate'
import type { RcaTemplate } from '../../../../../shared/rcaTemplate'

const patch = vi.fn()
vi.mock('../../../lib/settingsStore', async () => {
  const actual = await vi.importActual('../../../lib/settingsStore')
  return { ...actual, settingsStore: { patch: (p: unknown) => patch(p) } }
})

function renderWith(template: RcaTemplate = DEFAULT_RCA_TEMPLATE): void {
  render(<RcaTemplateSettings template={template} />)
}

beforeEach(() => patch.mockReset())

describe('RcaTemplateSettings', () => {
  it('lists both reports with their sections in order', () => {
    renderWith()
    const exec = screen.getByRole('list', { name: /executive summary sections/i })
    expect(
      within(exec)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toHaveLength(5)
    expect(screen.getByRole('list', { name: /technical report sections/i })).toBeTruthy()
  })

  it('renames a section heading', async () => {
    renderWith()
    const field = screen.getByLabelText('Heading for What happened in the executive summary')
    await userEvent.clear(field)
    await userEvent.type(field, 'Summary')
    await userEvent.tab()
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        rca: expect.objectContaining({
          template: expect.objectContaining({
            exec: expect.arrayContaining([expect.objectContaining({ heading: 'Summary' })])
          })
        })
      })
    )
  })

  it('sends the WHOLE template on any edit, both lists', async () => {
    renderWith()
    await userEvent.click(screen.getByLabelText('Enable Impact in the executive summary'))
    const sent = patch.mock.calls[0][0] as { rca: { template: RcaTemplate } }
    expect(sent.rca.template.exec).toHaveLength(5)
    expect(sent.rca.template.tech).toHaveLength(7)
  })

  it('toggles a section off', async () => {
    renderWith()
    await userEvent.click(screen.getByLabelText('Enable Impact in the executive summary'))
    const sent = patch.mock.calls[0][0] as { rca: { template: RcaTemplate } }
    expect(sent.rca.template.exec.find((s) => s.id === 'exec-impact')?.enabled).toBe(false)
  })

  it('moves a section up and reorders the list', async () => {
    renderWith()
    await userEvent.click(screen.getByLabelText('Move Impact up in the executive summary'))
    const sent = patch.mock.calls[0][0] as { rca: { template: RcaTemplate } }
    expect(sent.rca.template.exec.map((s) => s.id)).toEqual([
      'exec-impact',
      'exec-what-happened',
      'exec-root-cause',
      'exec-what-we-did',
      'exec-next-steps'
    ])
  })

  it('disables Move up on the first row', () => {
    renderWith()
    expect(screen.getByLabelText('Move What happened up in the executive summary')).toHaveProperty(
      'disabled',
      true
    )
  })

  it('adds a narrative section to the technical report with a unique id', async () => {
    renderWith()
    await userEvent.click(
      screen.getByRole('button', { name: /add a section to the technical report/i })
    )
    const sent = patch.mock.calls[0][0] as { rca: { template: RcaTemplate } }
    const added = sent.rca.template.tech.at(-1)!
    expect(added.kind).toBe('narrative')
    expect(added.enabled).toBe(true)
    expect(added.id.startsWith('tech-')).toBe(true)
    expect(sent.rca.template.tech.filter((s) => s.id === added.id)).toHaveLength(1)
  })

  it('offers no Remove on a claims row — claims sections are part of the contract', () => {
    renderWith()
    expect(screen.queryByLabelText('Remove Root cause from the technical report')).toBeNull()
    expect(screen.getByLabelText('Enable Root cause in the technical report')).toBeTruthy()
  })

  it('removes a user-added narrative section', async () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.tech.push({
      id: 'tech-detection',
      heading: 'Detection',
      kind: 'narrative',
      enabled: true,
      instruction: 'x'
    })
    renderWith(t)
    await userEvent.click(screen.getByLabelText('Remove Detection from the technical report'))
    const sent = patch.mock.calls[0][0] as { rca: { template: RcaTemplate } }
    expect(sent.rca.template.tech.some((s) => s.id === 'tech-detection')).toBe(false)
  })

  it('edits a narrative instruction but offers none for a claims section', async () => {
    renderWith()
    expect(
      screen.getByLabelText('Instruction for What happened in the executive summary')
    ).toBeTruthy()
    // tech "Root cause" is claims-kind: its content comes from the findings, not an instruction.
    expect(screen.queryByLabelText('Instruction for Root cause in the technical report')).toBeNull()
    // ...while the exec "Root cause" of the same NAME is narrative and does have one.
    expect(
      screen.getByLabelText('Instruction for Root cause in the executive summary')
    ).toBeTruthy()
  })

  it('names the two same-headed Root cause rows distinctly', () => {
    // Section headings are not unique — the default template ships a "Root cause" in each
    // report — so a control named after the heading alone would address two different fields.
    // getByLabelText throws on multiple matches, which is the assertion.
    renderWith()
    expect(screen.getByLabelText('Heading for Root cause in the executive summary')).toBeTruthy()
    expect(screen.getByLabelText('Heading for Root cause in the technical report')).toBeTruthy()
  })

  it('warns when a narrative section has an empty instruction, and does not patch', async () => {
    renderWith()
    const field = screen.getByLabelText('Instruction for What happened in the executive summary')
    await userEvent.clear(field)
    await userEvent.tab()
    expect(screen.getByRole('alert').textContent).toMatch(/instruction/i)
    expect(patch).not.toHaveBeenCalled()
  })

  it('resets to the shipped defaults', async () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.exec[0].heading = 'Changed'
    renderWith(t)
    await userEvent.click(screen.getByRole('button', { name: /reset to defaults/i }))
    expect(patch).toHaveBeenCalledWith({ rca: { template: DEFAULT_RCA_TEMPLATE } })
  })
})

describe('edits compose from the latest local state, not the last round-tripped prop', () => {
  // `settingsStore.patch` is async with no optimistic update: the `template` prop only refreshes
  // after main has round-tripped and written settings.json. Composing every payload from that
  // stale prop means a second edit within the IPC window silently reverts the first, and
  // `deepMerge` replaces arrays wholesale so the later stale write wins on disk.
  it('mints a distinct id when Add is clicked twice before the prop updates', async () => {
    renderWith()
    const add = screen.getByRole('button', { name: /add a section to the technical report/i })
    await userEvent.click(add)
    await userEvent.click(add)
    expect(patch).toHaveBeenCalledTimes(2)
    const second = patch.mock.calls[1][0] as { rca: { template: RcaTemplate } }
    const tech = second.rca.template.tech
    expect(tech).toHaveLength(DEFAULT_RCA_TEMPLATE.tech.length + 2)
    expect(new Set(tech.map((s) => s.id)).size).toBe(tech.length)
  })

  it('keeps a rename when a second control is touched before the prop updates', async () => {
    renderWith()
    const field = screen.getByLabelText('Heading for What happened in the executive summary')
    await userEvent.clear(field)
    await userEvent.type(field, 'Summary')
    await userEvent.tab()
    await userEvent.click(screen.getByLabelText('Enable Impact in the executive summary'))
    const last = patch.mock.calls.at(-1)![0] as { rca: { template: RcaTemplate } }
    const exec = last.rca.template.exec
    expect(exec.find((s) => s.id === 'exec-what-happened')?.heading).toBe('Summary')
    expect(exec.find((s) => s.id === 'exec-impact')?.enabled).toBe(false)
  })
})

describe('Reset to defaults repaints the fields', () => {
  it('shows the default heading after a reset, and blurring does not restore the old value', async () => {
    const t = structuredClone(DEFAULT_RCA_TEMPLATE)
    t.exec[0].heading = 'Changed heading'
    renderWith(t)
    await userEvent.click(screen.getByRole('button', { name: /reset to defaults/i }))
    // The row must now READ as the default; an uncontrolled input would still show the old text.
    const field = screen.getByLabelText('Heading for What happened in the executive summary')
    expect((field as HTMLInputElement).value).toBe('What happened')
    // ...and focusing/blurring it must not patch the discarded value back in.
    patch.mockReset()
    await userEvent.click(field)
    await userEvent.tab()
    for (const call of patch.mock.calls) {
      const sent = call[0] as { rca: { template: RcaTemplate } }
      expect(sent.rca.template.exec[0].heading).not.toBe('Changed heading')
    }
  })
})
