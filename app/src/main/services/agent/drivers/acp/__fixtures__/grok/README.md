# Grok ACP fixtures — DEFERRED

Live capture against the real `grok` CLI was **not performed** for this
task. Neither the `grok` binary nor an `XAI_API_KEY` is available in this
environment (owner-approved "build now, defer live capture" — see
`../EVIDENCE.md`).

This directory intentionally has no `.jsonl` fixtures yet. It exists (via
this README, since empty directories don't survive git) so Tasks 3-7 have a
stable path to write fixture-driven tests against once real fixtures land.

## How to populate this directory later

1. Install/authenticate Grok: obtain an `XAI_API_KEY`, and confirm the
   `grok` binary is on `PATH`.
2. From `app/`, run:

   ```bash
   cd app
   XAI_API_KEY=<key> AGENT=grok ./node_modules/.bin/electron scripts/acp-spike.mjs
   ```

   (Electron, not bare `node` — see `argus-electron-execpath-spawn-trap` in
   project memory.)

3. Confirm the actual launch argv Grok expects in ACP mode — the harness
   currently assumes `grok agent stdio` (see `PROFILES.grok` in
   `../../../../../../scripts/acp-spike.mjs`); this is UNVERIFIED (see
   EVIDENCE.md's ASSUMED section) and may need adjusting first.
4. Re-run for each scenario the harness drives (handshake, permission
   round-trip, tool-call stream, plan update, cancel, and an
   intentional auth-failure run with the API key unset). Pay particular
   attention to any `_`-prefixed extension request/notification Grok sends
   that standard ACP does not define (the xAI extension surface) — record it
   verbatim, the harness's `sessionUpdate`/`extMethod`/`extNotification`
   handlers already capture anything inbound.
5. Update `../EVIDENCE.md`: move the reconciled facts from "ASSUMED" to
   "CONFIRMED" with fixture citations, and add any new "ADJUST Task N" notes
   for whatever the live capture contradicts.
