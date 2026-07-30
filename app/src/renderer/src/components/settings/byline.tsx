import { authorName } from '../../../../shared/authorship'

/**
 * A row's description with `· by <name>` appended. Shared by the Library and HiveMind Browse so
 * the two lists read identically. Returns `undefined` (not an empty node) when there is nothing
 * to show, because SettingRow's `description` prop treats undefined as "no description line".
 */
export function withByline(description: string, author: string | null): React.ReactNode {
  const name = authorName(author)
  if (!name) return description || undefined
  return (
    <>
      {description}
      {description ? ' · ' : ''}
      <span className="text-mute">by {name}</span>
    </>
  )
}
