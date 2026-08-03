/**
 * A GitHub repository a pack is published from. `host` is a BARE hostname (no scheme), because
 * that is the form both `gh api --hostname <host>` and `gh release download -R <host>/<o>/<r>`
 * take. There is no `origin` here: the feed path pins a URL origin because a URL is all it has,
 * whereas a repo is a strictly narrower anchor — one origin serves many vendors, one repo does
 * not.
 */
export interface GhRef {
  host: string
  owner: string
  repo: string
}

/**
 * `owner/repo`, or `host/owner/repo`.
 *
 * The optional host segment is told apart from an owner by REQUIRING A DOT in it. No GitHub
 * owner may contain a dot, and every hostname worth naming has one, so the ambiguity between
 * `ghe.acme.com/o/r` and a three-segment path is decided without guessing. A repo name may
 * contain dots, which is why the dot rule is applied to the FIRST segment only.
 */
const REF = /^(?:([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/

/** `null` rather than a throw: each caller turns a bad ref into its own validation or IPC error. */
export function parseGhRef(ref: string): GhRef | null {
  const m = REF.exec(ref.trim())
  if (!m) return null
  return { host: m[1] ?? 'github.com', owner: m[2], repo: m[3] }
}

/** Case-insensitive, because GitHub owner and repo names are. */
export function sameGhRef(a: GhRef, b: GhRef): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  )
}

/** Round-trips through `parseGhRef`. The default host is omitted so UI reads `owner/repo`. */
export function formatGhRef(ref: GhRef): string {
  return ref.host === 'github.com'
    ? `${ref.owner}/${ref.repo}`
    : `${ref.host}/${ref.owner}/${ref.repo}`
}
