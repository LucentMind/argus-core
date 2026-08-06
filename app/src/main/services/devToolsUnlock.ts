import path from 'node:path'
import { JsonFileStore } from './fileStore'

/**
 * The click-6-times-on-the-version-number unlock for the prompt-override dev surface (spec
 * §6 follow-up). Lives outside `prompts/gate.ts` because that module stays a pure function of
 * injected booleans — this is the one place that touches disk.
 *
 * Separate file from settings.json for the same reason as `dev-prompt-overrides.json`: keeps
 * this dev-only marker out of the schema-validated object every user change writes.
 */
const UNLOCK_REL = ['config', 'dev-tools-unlock.json']

function unlockPath(argusHome: string): string {
  return path.join(argusHome, ...UNLOCK_REL)
}

/** Missing or unparsable file reads as not-unlocked — the same inert default as never having
 *  clicked. */
export function readDevToolsUnlocked(argusHome: string): boolean {
  const { data } = new JsonFileStore(unlockPath(argusHome)).load()
  return (data as { unlocked?: boolean } | null)?.unlocked === true
}

/** One-way: there is no hidden gesture to lock it back, same as `ARGUS_DEV_TOOLS=1` has no
 *  "unset" from inside the app. Takes effect on next launch — `devTools` is read once at boot
 *  and handed to several main-process singletons by their constructors, so flipping it live
 *  would mean making every one of those reactive instead of one flag read at startup. */
export function writeDevToolsUnlocked(argusHome: string): void {
  new JsonFileStore(unlockPath(argusHome)).write({ unlocked: true })
}
