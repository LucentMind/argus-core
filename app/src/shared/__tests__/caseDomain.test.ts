import { describe, it, expect } from 'vitest'
import { deriveCaseDomain, UNASSIGNED_DOMAIN } from '../caseDomain'

describe('deriveCaseDomain', () => {
  it('a Jira key yields its project prefix', () => {
    expect(deriveCaseDomain({ ticketProvider: 'jira', jiraKey: 'NAV-123' }, [])).toBe('NAV')
    expect(deriveCaseDomain({ ticketProvider: 'jira', jiraKey: 'ab_c2-9' }, [])).toBe('AB_C2')
  })
  it('a GitHub issue key yields owner/repo', () => {
    expect(deriveCaseDomain({ ticketProvider: 'github', jiraKey: 'acme/widgets#42' }, [])).toBe(
      'acme/widgets'
    )
  })
  it('falls back to the first workspace basename, with either separator', () => {
    expect(
      deriveCaseDomain({ ticketProvider: 'jira', jiraKey: null }, [{ path: 'C:\\src\\nav-core' }])
    ).toBe('nav-core')
    expect(
      deriveCaseDomain({ ticketProvider: 'jira', jiraKey: null }, [{ path: '/home/x/argus-core/' }])
    ).toBe('argus-core')
  })
  it('otherwise unassigned', () => {
    expect(deriveCaseDomain({ ticketProvider: 'jira', jiraKey: null }, [])).toBe(UNASSIGNED_DOMAIN)
    expect(deriveCaseDomain({ ticketProvider: 'jira', jiraKey: 'garbage' }, [])).toBe(
      UNASSIGNED_DOMAIN
    )
  })
})
