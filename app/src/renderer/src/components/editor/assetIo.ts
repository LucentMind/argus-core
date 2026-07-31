import type { AuthoringKind } from '../../../../shared/authoringIpc'

export interface AssetSnapshot {
  content: string
  hash: string
}

/**
 * The current on-disk state, or null when there is no such file — create mode, or an asset
 * deleted while a draft for it existed (§4.5).
 *
 * Never throws. Every caller here is a best-effort staleness check, and "not there" is an
 * answer rather than a failure.
 */
export async function readAsset(kind: AuthoringKind, name: string): Promise<AssetSnapshot | null> {
  try {
    const r =
      kind === 'skill'
        ? await window.argus.skills.read(name)
        : await window.argus.refsync.readRef(name)
    return { content: r.content, hash: r.hash }
  } catch {
    return null
  }
}

/** Resolves to the hash of the bytes actually written — the caller must adopt it as its next
 *  baseHash (see `AssetPane.onSave`). Rejects; conflict classification is the caller's. */
export async function writeAsset(
  kind: AuthoringKind,
  name: string,
  content: string,
  baseHash: string | null
): Promise<string> {
  if (kind === 'skill') {
    const { hash } = await window.argus.skills.write(name, content, baseHash)
    return hash
  }
  return window.argus.refsync.writeRef(name, content, baseHash)
}
