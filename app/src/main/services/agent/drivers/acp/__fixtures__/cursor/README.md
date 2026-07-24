# Cursor ACP fixtures — DEFERRED

Live capture against the real `cursor-agent` CLI was **not performed** for
this task. Neither the `cursor-agent` binary nor a `CURSOR_API_KEY` is
available in this environment (owner-approved "build now, defer live
capture" — see `../EVIDENCE.md`).

This directory intentionally has no `.jsonl` fixtures yet. It exists (via
this README, since empty directories don't survive git) so Tasks 3-7 have a
stable path to write fixture-driven tests against once real fixtures land.

## How to populate this directory later

1. Install/authenticate Cursor: obtain a `CURSOR_API_KEY` (or run
   `cursor-agent login`), and confirm the binary is on `PATH`.
2. From `app/`, run:

   ```bash
   cd app
   CURSOR_API_KEY=<key> AGENT=cursor ./node_modules/.bin/electron scripts/acp-spike.mjs
   ```

   (Electron, not bare `node` — see
   `argus-electron-execpath-spawn-trap` in project memory: some agent CLIs
   are Node-based launchers that die silently under Electron's main process
   if spawned incorrectly; the smoke/capture path must be exercised under
   Electron the same way the real app will run it.)

3. Confirm the actual launch argv Cursor expects in ACP mode — the harness
   currently assumes `cursor-agent acp` (see `PROFILES.cursor` in
   `../../../../../../scripts/acp-spike.mjs`); this is UNVERIFIED (see
   EVIDENCE.md's ASSUMED section) and may need adjusting first.
4. Re-run for each scenario the harness drives (handshake, permission
   round-trip, tool-call stream, plan update, cancel, and an
   intentional auth-failure run with the API key unset). Each scenario
   writes its own `<scenario>.jsonl` here.
5. Update `../EVIDENCE.md`: move the reconciled facts from "ASSUMED" to
   "CONFIRMED" with fixture citations, and add any new "ADJUST Task N" notes
   for whatever the live capture contradicts.
