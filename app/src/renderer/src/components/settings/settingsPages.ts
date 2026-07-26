import {
  Settings2,
  BrainCog,
  HeartPulse,
  Cable,
  CloudSync,
  HardDrive,
  BookMarked,
  Gauge,
  Package,
  Inbox,
  Braces,
  type LucideIcon
} from 'lucide-react'

/**
 * The settings nav table and its visibility rule.
 *
 * Lives outside `SettingsView.tsx` because that file exports a component: react-refresh
 * requires a component file to export only components, so a shared non-component export has
 * to be its own module.
 */

/** Sidebar pages in three labeled groups (spec §3.1): App / Knowledge / System. */
export const PAGES = [
  { id: 'general', label: 'General', group: 'App', enabled: true, Icon: Settings2 },
  { id: 'agent', label: 'Agent', group: 'App', enabled: true, Icon: BrainCog },
  { id: 'connectors', label: 'Connectors', group: 'App', enabled: true, Icon: Cable },
  { id: 'proposals', label: 'Proposals', group: 'Knowledge', enabled: true, Icon: Inbox },
  { id: 'library', label: 'Library', group: 'Knowledge', enabled: true, Icon: BookMarked },
  { id: 'memory', label: 'Memory', group: 'Knowledge', enabled: true, Icon: HardDrive },
  { id: 'team', label: 'Team', group: 'Knowledge', enabled: true, Icon: CloudSync },
  { id: 'sources', label: 'Sources', group: 'Knowledge', enabled: true, Icon: Package },
  { id: 'health', label: 'Health', group: 'System', enabled: true, Icon: HeartPulse },
  { id: 'observability', label: 'Observability', group: 'System', enabled: true, Icon: Gauge },
  { id: 'prompts', label: 'Prompts', group: 'System', enabled: true, devOnly: true, Icon: Braces }
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  group: 'App' | 'Knowledge' | 'System'
  enabled: boolean
  /** Hidden entirely unless the dev-tools gate is on. Distinct from `enabled: false`, which
   *  renders a greyed-out "soon" button and would advertise the page in a shipped build. */
  devOnly?: boolean
  Icon: LucideIcon
}>
export type PageId = (typeof PAGES)[number]['id']

/** Pages to render for this payload. Exported for direct testing: rendering the whole
 *  SettingsView to assert one nav entry would drag in every settings page as a dependency. */
export function visiblePages(devTools: boolean): (typeof PAGES)[number][] {
  return PAGES.filter((p) => !('devOnly' in p && p.devOnly) || devTools)
}
