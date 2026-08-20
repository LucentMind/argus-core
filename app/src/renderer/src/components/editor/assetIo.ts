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
 *
 * `file`, when given, is a sibling of the skill named by `name` — always a skill's, regardless
 * of `kind` (a reference has no siblings), which is why it is checked first and short-circuits
 * the existing `kind` branch below rather than folding into it. `SkillFileRead` also carries
 * `executable`/`tier`/`editable`, but `AssetSnapshot` only ever needed `content`/`hash`
 * (read-only-ness is `EditorApp`'s `tierOf`/`isAssetEditable` computation, unaffected by `file` —
 * see its comment there), so those three are read and dropped here rather than threaded through
 * as placeholders on a type that has no use for them yet.
 */
export async function readAsset(
  kind: AuthoringKind,
  name: string,
  file?: string
): Promise<AssetSnapshot | null> {
  try {
    if (file) {
      const r = await window.argus.skills.readFile(name, file)
      return r ? { content: r.content, hash: r.hash } : null
    }
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
 *  baseHash (see `AssetPane.onSave`). Rejects; conflict classification is the caller's.
 *
 *  `file`, when given, is a sibling of the skill named by `name` — see `readAsset`'s comment on
 *  the same parameter. `SkillFileWriteResult` also carries `executable`, which this function has
 *  no use for: it exists so main can record a `skill_asset_reviews` row, not for the caller here. */
export async function writeAsset(
  kind: AuthoringKind,
  name: string,
  content: string,
  baseHash: string | null,
  file?: string
): Promise<string> {
  if (file) {
    const { hash } = await window.argus.skills.writeFile(name, file, content, baseHash)
    return hash
  }
  if (kind === 'skill') {
    const { hash } = await window.argus.skills.write(name, content, baseHash)
    return hash
  }
  return window.argus.refsync.writeRef(name, content, baseHash)
}
