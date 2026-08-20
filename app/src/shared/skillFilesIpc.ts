import type { SkillAssetTier } from './skillAssets'

/** One sibling file of a skill, as the editor's Files dock sees it. */
export interface SkillFileEntry {
  /** POSIX-separated, relative to the skill directory — the spelling
   *  `skill_asset_reviews.rel_path` stores and `assetPathError` validates. */
  relPath: string
  bytes: number
  /** `isExecutableAsset`: extension or shebang. Drives the dock's badge and the review row. */
  executable: boolean
  /** The tier the skill resolved to, not the file's own — a file has no tier of its own. */
  tier: SkillAssetTier
  /** Whether main would accept a write here. An affordance for the renderer; main re-checks. */
  editable: boolean
}

export interface SkillFileRead {
  content: string
  hash: string
  executable: boolean
  tier: SkillAssetTier
  editable: boolean
}

export interface SkillFileWriteResult {
  hash: string
  executable: boolean
}
