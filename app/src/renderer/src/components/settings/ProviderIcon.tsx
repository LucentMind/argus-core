import { Boxes } from 'lucide-react'
import { ClaudeIcon } from './ClaudeIcon'
import { CopilotIcon } from './CopilotIcon'

/** Per-driver glyphs, keyed by `DriverDefinition.kind`. A driver missing from this map
 *  falls back to a neutral mark rather than borrowing another vendor's — showing the
 *  Claude asterisk next to "Copilot" was the bug this map exists to prevent. */
const ICONS: Record<string, (p: { className?: string }) => React.JSX.Element> = {
  'claude-agent-sdk': ClaudeIcon,
  'github-copilot': CopilotIcon
}

export function ProviderIcon({
  kind,
  className = ''
}: {
  kind: string
  className?: string
}): React.JSX.Element {
  const Icon = ICONS[kind]
  if (Icon) return <Icon className={className} />
  return <Boxes size={16} strokeWidth={1.5} aria-hidden className={className} />
}
