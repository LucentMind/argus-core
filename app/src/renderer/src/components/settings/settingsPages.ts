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
  Activity,
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
  {
    id: 'general',
    label: 'General',
    group: 'App',
    enabled: true,
    Icon: Settings2,
    blurb: 'Appearance, case defaults, and how the workspace shell behaves.'
  },
  {
    id: 'agent',
    label: 'Agent',
    group: 'App',
    enabled: true,
    Icon: BrainCog,
    blurb: 'Providers, models, and what the analyst may do without asking.'
  },
  {
    id: 'connectors',
    label: 'Connectors',
    group: 'App',
    enabled: true,
    Icon: Cable,
    blurb: 'External systems Argus can reach — Atlassian and any other MCP server.'
  },
  {
    id: 'proposals',
    label: 'Proposals',
    group: 'Knowledge',
    enabled: true,
    Icon: Inbox,
    blurb: 'Proposals the agent drafted during sessions or case distillation, awaiting your review.'
  },
  {
    id: 'library',
    label: 'Library',
    group: 'Knowledge',
    enabled: true,
    Icon: BookMarked,
    blurb: 'Skills and references available to the analyst, and which this workspace owns.'
  },
  {
    id: 'memory',
    label: 'Memory',
    group: 'Knowledge',
    enabled: true,
    Icon: HardDrive,
    blurb: 'What the analyst remembers between sessions, and the rules that let it forget.'
  },
  {
    id: 'team',
    label: 'Team',
    group: 'Knowledge',
    enabled: true,
    Icon: CloudSync,
    blurb:
      'Skills, references, and defect corpora your team shares — install, update, or connect them.'
  },
  {
    id: 'sources',
    label: 'Sources',
    group: 'System',
    enabled: true,
    Icon: Package,
    // Confluence moved to Team (2026-08-01, user-directed) — it is a shared upstream that a
    // workspace subscribes to, which is what the Team page is. What is left here is pack
    // installation and update state: machinery, not knowledge, hence the move to System.
    blurb: 'Installed knowledge packs, where they came from, and their update state.'
  },
  {
    id: 'health',
    label: 'Health',
    group: 'System',
    enabled: true,
    Icon: HeartPulse,
    blurb:
      'Provider reachability, binary resolution, and the checks Argus runs on open or on demand.'
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    group: 'System',
    enabled: true,
    Icon: Activity,
    blurb:
      'Live CPU and memory for every process Argus runs, attributed to the process tree that owns it.'
  },
  {
    id: 'observability',
    label: 'Observability',
    group: 'System',
    enabled: true,
    Icon: Gauge,
    blurb: 'Langfuse tracing setup, what content it captures, and which dashboard cards show.'
  },
  {
    id: 'prompts',
    label: 'Prompts',
    group: 'System',
    enabled: true,
    devOnly: true,
    Icon: Braces,
    blurb:
      'Developer view of prompt entries, a next-session preview, and exact past-session captures.'
  }
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  group: 'App' | 'Knowledge' | 'System'
  enabled: boolean
  /** One line under the page title, published to `settingsBarStore` and rendered in the header's
   *  Settings identity group (TopBar), not in the page body — Settings has no masthead of its
   *  own any more. Same rule as SettingsSection's subtitle: state what the page's rows have in
   *  common. */
  blurb: string
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
