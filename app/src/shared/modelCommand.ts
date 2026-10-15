/**
 * `/model <name>` — switch the open chat's model by typing it.
 *
 * Handled by Argus, never sent to the CLI: the CLI's own `/model` changes state Argus pins per
 * session (see the comment on the Claude driver's `slashCommands`). This module is the pure part:
 * recognise the command, then decide what the argument means. The composer does the rest —
 * pinning the session and persisting whatever needs persisting.
 */
import { modelMatches, resolvesToId } from './modelIdentity'
import type { CatalogModel } from './drivers'

/** Longest id a custom model may have. Shared with the Settings add form so the two cannot
 *  disagree about what is acceptable. */
export const MAX_CUSTOM_MODEL_LENGTH = 100

/** `{ arg }` for a `/model` message (`arg` is '' when none was typed), null for anything else —
 *  including a multi-line message, which is prose that happens to start with the word. */
export function parseModelCommand(text: string): { arg: string } | null {
  const t = text.trim()
  if (t.includes('\n')) return null
  const m = /^\/model(?:\s+(.*))?$/.exec(t)
  return m ? { arg: (m[1] ?? '').trim() } : null
}

export type ModelCommandResult =
  /** The argument names a row that already exists (visible or not). */
  | { kind: 'match'; row: CatalogModel }
  /** Unknown, but shaped like a model id: offer it as a custom model, as typed. */
  | { kind: 'custom'; slug: string }
  | { kind: 'invalid'; reason: string }

/**
 * What `arg` means against `rows` — EVERY row the instance knows (catalog, built-ins, custom),
 * including ones the picker currently hides as outdated: asking for Opus 4.8 by name must find
 * Opus 4.8, not mint a duplicate custom entry for it.
 *
 * Matched case-insensitively, most specific first: the row's own slug (an alias like `opus`, or a
 * wire slug), then its `resolvedModel` / a `[1m]` or dated form of either (the shared
 * {@link modelMatches}), then its display name. Slug beats name so `b` can never be captured by
 * another row that happens to be called "b".
 */
export function resolveModelCommand(
  arg: string,
  rows: readonly CatalogModel[]
): ModelCommandResult {
  const wanted = arg.trim()
  if (!wanted) return { kind: 'invalid', reason: 'Name a model, e.g. /model claude-sonnet-5-5.' }
  const lower = wanted.toLowerCase()
  const bare = lower.replace(/\[1m\]$/, '')

  const row =
    rows.find((r) => r.slug.toLowerCase() === lower) ??
    rows.find((r) => r.resolvedModel?.toLowerCase() === lower) ??
    rows.find((r) =>
      modelMatches(
        { value: r.slug.toLowerCase(), resolvedModel: r.resolvedModel?.toLowerCase() },
        lower
      )
    ) ??
    // the typed id carries the CLI's build date (`claude-haiku-4-5-20251001`) and the row is the
    // undated static slug — `modelMatches` only knows the date on the row side
    rows.find((r) => resolvesToId(bare, r.slug.toLowerCase())) ??
    rows.find((r) => r.name.toLowerCase() === lower)
  if (row) return { kind: 'match', row }

  if (/\s/.test(wanted)) {
    return {
      kind: 'invalid',
      reason: `No model is called "${wanted}", and model ids have no spaces.`
    }
  }
  if (wanted.length > MAX_CUSTOM_MODEL_LENGTH) {
    return {
      kind: 'invalid',
      reason: `Model ids must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`
    }
  }
  return { kind: 'custom', slug: wanted }
}
