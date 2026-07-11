// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { InstalledSkills } from '../InstalledSkills'
import type { SkillsPayload } from '../../../../../shared/memoryIpc'

const initial: SkillsPayload = {
  skills: [
    {
      name: 'rca',
      tier: 'user',
      description: 'local adaptation',
      enabled: true,
      shadows: ['hivemind', 'bundled']
    },
    { name: 'my-notes', tier: 'user', description: 'plain user skill', enabled: true, shadows: [] },
    { name: 'hive-probe', tier: 'hivemind', description: 'probe', enabled: true, shadows: [] },
    { name: 'analyze-applog', tier: 'bundled', description: 'applog', enabled: true, shadows: [] }
  ]
}

const afterAdopt: SkillsPayload = {
  skills: [
    {
      name: 'rca',
      tier: 'hivemind',
      description: 'upstream rca',
      enabled: true,
      shadows: ['bundled']
    },
    { name: 'my-notes', tier: 'user', description: 'plain user skill', enabled: true, shadows: [] },
    { name: 'hive-probe', tier: 'hivemind', description: 'probe', enabled: true, shadows: [] },
    { name: 'analyze-applog', tier: 'bundled', description: 'applog', enabled: true, shadows: [] }
  ]
}

function mockArgus(): {
  skills: { list: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> }
} {
  return {
    skills: {
      list: vi.fn().mockResolvedValue(initial),
      deleteUser: vi.fn().mockResolvedValue(afterAdopt)
    }
  }
}

let argus: ReturnType<typeof mockArgus>

beforeEach(() => {
  argus = mockArgus()
  ;(window as unknown as { argus: unknown }).argus = argus
  window.confirm = vi.fn(() => true)
})

describe('InstalledSkills delete/adopt actions', () => {
  it('user skill shadowing hivemind gets "Adopt upstream"; confirm deletes and refreshes', async () => {
    render(<InstalledSkills />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt upstream · rca' }))
    expect(window.confirm).toHaveBeenCalled()
    await waitFor(() => expect(argus.skills.deleteUser).toHaveBeenCalledWith('rca'))
    // list now shows the hivemind winner from the returned payload
    expect(await screen.findByText('upstream rca')).toBeInTheDocument()
    expect(screen.queryByText('local adaptation')).not.toBeInTheDocument()
  })

  it('plain user skill gets a Delete action', async () => {
    render(<InstalledSkills />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete · my-notes' }))
    await waitFor(() => expect(argus.skills.deleteUser).toHaveBeenCalledWith('my-notes'))
  })

  it('cancelling the confirm leaves the skill alone', async () => {
    window.confirm = vi.fn(() => false)
    render(<InstalledSkills />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt upstream · rca' }))
    expect(window.confirm).toHaveBeenCalled()
    expect(argus.skills.deleteUser).not.toHaveBeenCalled()
  })

  it('hivemind and bundled rows offer no delete action', async () => {
    render(<InstalledSkills />)
    await screen.findByText('hive-probe')
    expect(screen.queryByRole('button', { name: /hive-probe/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /analyze-applog/ })).not.toBeInTheDocument()
  })

  it('a rejected delete surfaces an error and keeps the list', async () => {
    argus.skills.deleteUser = vi.fn().mockRejectedValue(new Error('EPERM: locked'))
    render(<InstalledSkills />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt upstream · rca' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/EPERM: locked/)
    expect(screen.getByText('local adaptation')).toBeInTheDocument()
  })
})
