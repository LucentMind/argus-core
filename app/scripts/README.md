# Dev scripts

## seed-test-home.mjs

Seeds one `ARGUS_HOME` covering every surface of the app: five cases (four bound to real
`JiaweiHan88/HiveMindTest` pull requests, one fabricated), findings across every severity, layer,
review state and status-badge combination, evidence and review-artifact trees, proposals in every
type and reject-reason tag, skills and references across every tier, distill jobs and case
summaries.

```bash
ARGUS_HOME=/path/to/home npm run dev                                    # boot once so migrations run, then quit
ARGUS_HOME=/path/to/home node --experimental-sqlite scripts/seed-test-home.mjs
ARGUS_HOME=/path/to/home npm run dev                                    # boot again, click Rescan once per case IN EACH MODE
```

`scanEvidence` is per mode — it only scans `modeDir(argusHome, slug, mode)` and reconciles that
mode's rows, and the Rescan button passes whichever mode is currently active. Every seeded case
starts in `review` mode, so clicking Rescan once (as the plain phrase above might suggest) only
ingests `artifacts/`. To also ingest the `evidence/` tree, switch the case to `investigation` mode,
click Rescan, then switch back to `review` and click Rescan again. Skipping the investigation-mode
pass leaves the entire `evidence/` tree uningested — it never enters the database at all.

Requires `git` and `gh` on `PATH`, with `gh` **authenticated** for the target repository — the
script's preflight runs `gh auth status`, not just a presence check, so a `gh` that is installed
but logged out is still rejected before anything is written.

### Safety guard

The script refuses to run destructively against a home it does not own:

- It refuses the app's default home (`~/Argus`) outright, under any flag, including `--force`.
- Against any other home, it refuses to run if that home holds content it did not author
  (existing `references/`, `skills-user/`, `skills-hivemind/`, `memory/` or `proposals/`) unless
  you pass `--force`.
- On a successful run it writes a `.argus-seed-home` marker into the home. A home carrying that
  marker needs no `--force` to re-seed — the marker is proof a prior run of this same script
  owns it.
- `config/hivemind-state.json`, `config/settings.json`, `config/agent-access.json` and
  `config/tool-risk.json` are overwritten wholesale on every run (they are deliberately excluded
  from the marker/guard check above — a freshly booted home always has a fully-configured
  `config/` even before it has ever been seeded, so guarding it there would make every first seed
  of a scratch home demand `--force`). Each file's contents from just before the *first* such
  overwrite are backed up to `config/.seed-backup/<name>.json`. That backup is first-generation
  wins: once a backup for a name exists, a later run never replaces it, so it stays whatever
  predated the seed rather than turning into a copy of the seed's own output.

### Evidence is not pre-seeded

**Evidence rows do not exist until you click Rescan.** The seed writes the `evidence/` and
`artifacts/` trees to disk as plain files and leaves the app's own `scanEvidence` (via the
Rescan action) to ingest them into the database. This is deliberate: a fixture that
reimplemented `indexer.ts`'s chunking would drift out of sync with the real implementation over
time and start lying about how evidence search actually behaves.

### Re-running

Idempotent: per-case destructive, globally additive for anything outside the seed's own scope.
Each of the five seeded slugs' cases (sessions, turns, tool calls, findings, PR bindings,
evidence/artifacts trees, worktrees, `distill_jobs` and `case_summaries` rows) is deleted and
rebuilt from scratch — scoped to the five roster slugs, never a blanket wipe of those two tables.
Separately, the knowledge trees — `proposals/` (incl. `archive/`), `skills-user/`,
`skills-hivemind/`, `references/` and `memory/` — are wiped and rebuilt wholesale on every run
(there is no per-case scoping for these; they are not case-owned data). The four `config/*.json`
files above are overwritten every run too (see the safety guard). Everything else already present
in `ARGUS_HOME` is left alone.

### Not covered

The `running` and `unstable` pull-request check-rollup states are not represented anywhere in the
seed. `running` exists only mid-workflow — a check that is actually in progress — so it can't be
captured as a static fixture; to see it live, re-run a job (`gh run rerun`) on pull request 6 and
open that case while the run is in flight. `unstable` is unreachable by this fixture: it needs a
non-required *failing* check, which needs branch protection that `JiaweiHan88/HiveMindTest` does
not have. `unavailable` IS covered — `SYN-5-edge`'s pull request (999) does not exist, and the
app's own first-mount refresh writes a real `unavailable` status for it within a second of boot.

## findings-layout-fixture.mjs

Narrow fixture for `findings-layout-probe.mjs`, the committed CDP layout gate. Kept separate from
the seed above on purpose: the probe depends on its exact shape (worst-case severity/layer/badge
combinations at `FINDINGS_MIN_WIDTH`), so folding it into the broader seed would risk the gate
silently drifting whenever the broader seed's fixture data changes for unrelated reasons.
