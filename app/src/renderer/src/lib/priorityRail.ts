/**
 * Maps a Jira priority name to a dynamic-theme rail tier (`--p1/--p2/--p3` in
 * theme-dynamic.css). The names are the real Jira scheme — the same vocabulary
 * PRIORITY_RANK in main/services/caseService.ts sorts by — matched
 * case-insensitively. Unknown or unset priorities get no rail.
 */
export function railTier(priority: string | null): 'p1' | 'p2' | 'p3' | null {
  switch (priority?.toLowerCase()) {
    case 'highest':
    case 'high':
      return 'p1'
    case 'medium':
      return 'p2'
    case 'low':
    case 'lowest':
      return 'p3'
    default:
      return null
  }
}
