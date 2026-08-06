/**
 * Dev-tools gate for the prompt surface (spec §6).
 *
 * `isDev` is INJECTED rather than read from `@electron-toolkit/utils` here: that package
 * imports `electron` transitively, and a main-process module under test must not. The single
 * production caller (`main/index.ts`) already imports `is` and passes `is.dev`.
 *
 * A packaged build needs the env override because several bugs in this app reproduce ONLY when
 * packaged (see the asar-unpacked and execPath spawn traps), so the surface has to be reachable
 * in the artifact we actually ship. `unlocked` is the same escape hatch reached from inside the
 * app — clicking the version number 6 times in a packaged build persists a marker file (see
 * `devToolsUnlock.ts`) that `main/index.ts` reads and passes in here, for anyone who cannot set
 * an environment variable before launch.
 */
export function devToolsEnabled(deps: {
  isDev: boolean
  env?: NodeJS.ProcessEnv
  unlocked?: boolean
}): boolean {
  // Exact '1' only: a loose truthy check would silently enable the surface for someone who set
  // ARGUS_DEV_TOOLS=0 intending to disable it.
  return deps.isDev || (deps.env ?? process.env).ARGUS_DEV_TOOLS === '1' || Boolean(deps.unlocked)
}
