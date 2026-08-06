# Changelog

## v2.0.7 — 2026-08-06

120 commits since v2.0.6, 149 files changed (+12,270 / −1,071).

### Added

**Related History explorer**

- A new relevance engine — reciprocal-rank fusion over per-source hits,
  FTS5-backed document-frequency suppression and term-overlap scoring, and a
  query builder that matches strong-signal terms (ticket key, signature,
  error strings) by prefix but weak-signal terms (title, finding text, free
  query words) only exactly — replaces the old `distill:similar` lookup with
  a `RelatedHistoryService` fan-out that reports every configured source's
  health, not just the ones that returned hits.
- A full explorer surface, opened from the case card and the top bar, offers
  a filter rail with per-source status, facets and retrieval mode,
  seeded-query search with paging and a degraded-source banner, and an
  in-app detail view for either a corpus record or a local case; a merged
  related-history card summarizes results directly in the case workspace.
- From the explorer or the merged card, a hit can be referenced in chat,
  attached to the case as evidence, or pulled in as a full corpus record;
  the local own-case-history provider stays off by default behind a new
  `similarPastCasesEnabled` toggle in General settings.
- A long tail of relevance fixes closed real false-positive cases surfaced
  by review: a source-blind rarity-relaxation rule was reviving the exact
  "incidental title word" bug the feature exists to prevent, ticket-key
  matching was prefix- not exact-matching (so `KAN-4` also matched `KAN-42`
  and every other later ticket sharing its prefix), and the small-corpus
  document-frequency threshold was bypassed rather than floored below
  population 4.

**Reuse an open share PR**

- Sharing a skill or reference to HiveMind now checks `pushStatus` first: a
  teammate's open PR blocks the push, an unchanged PR of ours is returned
  as-is, and a changed one gets a new commit on its existing branch — so
  re-sharing after a small edit no longer opens a second PR for the same
  asset. The share dialog renders these already-open states directly.
- Authorship detection (`isSoleAuthor`) no longer misreads a forked or
  claimed asset as solely-authored just because its `author` field is
  absent, and push receipts are now scoped to the repo they were actually
  pushed to and validated against the resolved PR's branch — both were
  previously reachable ways to misattribute or cross-wire a push.
- The Team page auto-syncs the HiveMind repo in the background as soon as
  it's reachable, so the Browse list is usually already fresh without a
  manual Sync click, and gains a "Download All" action per section.

**Memory write discipline**

- Every `write_memory` call now requires an explicit scope, and writing a
  topic replaces its body outright (backing the previous version up to a
  `.bak` file) instead of appending to it forever; an agent-written topic
  body is capped at 4096 bytes.
- The memory-append proposal type is gone, and the distiller no longer
  proposes memory writes at all — team-facing knowledge is redirected to a
  reference-edit proposal, case detail to `append_finding`. Tool
  descriptions and the memory header now state the personal-only memory
  rule explicitly.
- The Memory settings page shows each topic's scope, size, and whether it's
  over the byte cap.

**Pack immutability, continued**

- Pack binaries can now declare `bundled: false`, requiring a `fixHint`,
  enforced at `pack-tools` build time.
- Build-time robustness fixes: symlinked entries in a bundled directory are
  caught instead of silently followed, dev artifacts are excluded from the
  bundle, and a missing `--bin` directory is tolerated instead of failing
  the build.

### Fixed

- **Security:** untrusted markdown — corpus descriptions and comments in the
  new related-history detail pane, plus Jira ticket/comment evidence files
  that reach the same viewer — now renders through a single trusted anchor
  gate instead of a second, unhardened route. A plain `https` link in that
  second route previously rendered as a bare same-window anchor, able to
  navigate the app's own window directly without ever reaching the
  external-link-open guard.
- Diagnostics: the sidecar's per-process command field is capped at 256
  bytes, a single oversized line no longer kills the sidecar connection,
  and that guard is now gated on handshake completion so it can't misfire
  before the real binary has spoken.
- Composer: replying while a staged draft already sat in the box destroyed
  the typed text instead of appending to it.
- The Jira rail's "Ticket · <key>" box duplicated on every case switch — it
  shared a bare React key with the repos section, so a stale instance from
  the previous case never got torn down and each revisit stacked another
  copy.
- Library rows: Delete/Adopt-upstream moved to the end of the row (was
  leading), styled persistently red (the danger color was losing to
  `IconBtn`'s own hover style through stylesheet ordering), with larger row
  action icons.
- `dataRoot.fromEnv` now reports correctly when running under `ARGUS_HOME`.
- Bundled and pack-owned skills, references, and proposals now consistently
  refuse fork/shadow/accept operations that would overwrite a locked
  asset — a cross-cutting gap across the Library, editor window, and
  Proposals page that no single per-task review had caught, closed by an
  8-finding whole-branch review pass.

## v2.0.6 — 2026-08-04

31 commits since v2.0.5, 60 files changed (+3,069 / −250).

### Added

**Cancel a distillation in progress**

- A queued or running case distillation can now be cancelled from the case
  menu on an open case or from its bar chip while in flight, over a new
  `distill:cancel` IPC channel with an abort signal threaded through the
  headless runner in all three drivers (Claude, Codex, Copilot).
- Cancellation is epoch-guarded through reconciliation, retries, and case
  close, so a stale broadcast or a superseded job can't resurrect a
  cancelled run or clobber newer work with an old retry.
- The distiller is now told when a case is still open rather than closed,
  which advances the prompt hash.

**Multiple default repositories**

- `general.defaultRepos` replaces the single `defaultRepo` setting (with a
  one-time migration), and every default repo now auto-links to a new case,
  not just one.
- Settings shows a Default repositories list — add via a recents-dropdown
  picker that falls through to the native dialog, remove one at a time.
- The case rail gets the same recents picker; per-case repo-link usage is
  tracked to drive a promote-to-default prompt.

### Fixed

- The repo picker's dropdown panel was clipped mid-list inside the case
  rail's scroll container — no `z-index` can escape an ancestor's
  `overflow` clip, so `MenuButton` gained an opt-in `portal` mode that
  renders the panel on `<body>` instead (closing on scroll/resize, since a
  fixed panel can't follow a scrolling anchor).
- A `Btn` size override was inert; box metrics now interpolate instead of
  jumping between fixed presets.
- `repoUsage` test fixtures made platform-native.

## v2.0.5 — 2026-08-03

8 commits since v2.0.4, 22 files changed (+1,932 / −37).

### Added

**Defect corpus admin config**

- Defect corpus sources move out of the Team page into their own dedicated
  Settings page, with a per-source ingestion config editor and admin config
  passthroughs (typed failure codes) to each source's backend.
- A JQL dry-run preview in the ingestion editor lets you check a source's
  query against real results before saving it.

### Fixed

- Defect corpus: the LLM endpoint field, admin-config load retry, admin
  timeout, and per-source group passthrough.
- Packs: the relaunch prompt now survives leaving the Packs page or opening
  a second window — main tracks the pack ids it has actually written since
  the registry loaded and reports that as a durable `relaunchRequired`
  signal, instead of relying on an installed/loaded version comparison that
  reads as "settled" on both a same-version reinstall and an uninstall. The
  Relaunch button also no longer disables itself on the page's own
  in-flight `busy` flag, which could strand it after an operation that
  failed to settle.

## v2.0.4 — 2026-08-03

31 commits since v2.0.3, 78 files changed (+6,735 / −91).

### Added

**RCA (root cause analysis) reports**

- A case now generates a draft RCA report through the same queued job runner
  as case distillation: an assembly step gathers investigation findings,
  ticket markdown, and transcript tails into a prompt, a job runs and
  validates it, and the result renders into deterministic exec-summary and
  tech-drill-down markdown.
- A review panel (opened from the Findings pane header) shows the draft as
  per-section claim cards with a role select (root cause, contributing,
  symptom, duplicate, or unclassified) and duplicate-veto checkboxes, with
  Exec/Tech markdown previews before you confirm and freeze it.
- Confirming posts the report — the tech drill-down goes to Jira as an
  attachment or a Confluence page, then an exec-summary Jira comment
  references it; each target posts independently and a retry only redoes
  the failed half. Reopening a case with a confirmed RCA resumes from that
  draft instead of starting over.

**Known-defects search (Hindsight)**

- A defect-corpus client with per-source isolation lets the agent search
  prior known defects through a new `search_known_defects` tool (nudged into
  the persona for relevant investigations), surfaced in a new section on the
  case's Similar Cases card.
- Sources are configured under Settings → Team; corpus-controlled URLs are
  guarded before the app follows them.

**Findings**

- Findings now carry a role (root cause, contributing, symptom, duplicate,
  ruled-out), assigned when an RCA report is confirmed; the findings list
  orders by role rank before newest-first, and each card shows a passive
  role chip.
- Individual findings can be deleted from a hover-revealed trash button on
  the card, behind a confirm dialog.

### Fixed

- macOS: the `gh` child process's environment is now built fresh on every
  spawn instead of snapshotted once at module load, so a PATH that only
  becomes valid after the app finishes launching is picked up (previously
  surfaced as "gh is not installed" in packaged builds).
- RCA: a null site URL now throws instead of silently no-op'ing, a
  same-target retry overwrites its prior result instead of duplicating it,
  `readPriorDraft` distinguishes a missing file from a real read error, and
  a report with no identifiable root cause renders an explicit placeholder
  instead of an empty section.
- A failed finding-delete IPC call is now handled in the Findings pane
  instead of failing silently.

### Internal

- `docs/`: an exit-check and architecture note for the Hindsight
  integration.
- Case distillation now folds a finding's role and the confirmed RCA
  structure into its prompt input for closed cases (the static prompt hash
  advances accordingly).
- A one-shot `callTool` was added to `McpService`, reusing the existing
  probe connection lifecycle for single tool invocations (used by the RCA
  posting flow's Jira/Confluence calls).

## v2.0.3 — 2026-08-03

19 commits since v2.0.2, 27 files changed (+2,871 / −73).

### Added

**Install and update packs from a GitHub repository**

- Packs can now be discovered and installed straight from a GitHub repo, not
  only from a vendor update feed: a union pack source merges both, and a new
  `updateRepo` manifest field pins a pack to the repo it was installed from.
- Updates are synthesized from GitHub release metadata and checked/applied the
  same way as feed-based updates, through a dedicated `gh` subprocess seam that
  classifies failures (auth, rate limit, not-found, ...) instead of surfacing
  raw subprocess errors.
- `docs/authoring-packs.md` documents `updateRepo` and how to publish a pack via
  GitHub releases.

### Fixed

- A pack's GitHub pin is refused rather than silently dropped or substituted if
  it changes mid-apply, and is kept through a normal update.
- Installing never targets a different repo than the one shown on screen.
- One unparseable manifest in a repo's release no longer hides that repo's
  other, valid packs.
- The pack row surfaces `gh` auth failures directly instead of failing silently
  or falling back to a stale state; the check/apply path fails closed on a repo
  it can't verify.

### Internal

- A CDP runtime gate exercises the GitHub pack source against a real private
  repository (15/15 on the live check).
- The release pipeline (`.github/workflows/build.yml`) now publishes a tagged
  release immediately instead of creating a draft — pushing a `vX.Y.Z` tag
  ships it, with no separate human "publish the draft" step. See
  `docs/releasing.md`.

## v2.0.2 — 2026-08-03

3 commits since v2.0.1, 14 files changed (+1,287 / −315).

### Fixed

- A freshly created chat's composer chips (model, run options, permission)
  were unresponsive until you left and re-entered the case — `SessionSwitcher`
  and `CaseWorkspace` held separate copies of the session list, so the new
  chat's row was invisible to the workspace that renders the chips. Both now
  read one shared session store.
- The composer's option row now collapses one control at a time (Tool
  results, then Access, then Traits) as the pane narrows, instead of
  overflowing between 650px and its own ~760-790px worst-case width, or
  hiding every control at once below that threshold. The Model chip's width
  is now capped so it can't feed back into the fit calculation it's an input
  to.
- Per-model run options are now curated against measured capabilities rather
  than derived alone: Sonnet 4.6 loses Extra High/Ultracode (its effort was
  silently capped at "high" even when the chip claimed `xhigh`); Sonnet 5 and
  Opus 4.7 lose Ultracode (unverified, held back out of caution); Opus 4.8 and
  4.7 lose Context Window (this one contradicts an earlier measurement and is
  flagged in code for revisit); Opus 5, Haiku, Fable, and Opus 4.8's Ultracode
  are unchanged. Marked provisional in code pending reconciliation.
- Thinking is now offered only to models without a separate Reasoning control
  (Haiku gains it; Fable/Sonnet/Opus lose it) — effort already covers that
  axis more expressively on the models that have one.

## v2.0.1 — 2026-08-03

11 commits since v2.0.0, 25 files changed (+3,773 / −77).

### Added

**Chat**

- A "matrix-decode" thinking indicator animates in the chat pane while the
  agent works silently between visible turns, so a long silent stretch reads
  as progress instead of a stall.

### Fixed

- macOS header: the masthead no longer overlaps the traffic-light inset, the
  ready-pill's status popup positions correctly, and the ambient canvas keeps
  enough contrast behind it.
- Seed data no longer writes the collapsed legacy case status.

### Internal

- A new demo-data seed script (`seed-demo-home.mjs`) builds a realistic-looking
  home view for taking product screenshots.
- Marketing-site updates (landing page hero/carousel, a Web3Forms-backed
  book-a-demo form, the new Argus icon mark, and a `CNAME` for the custom
  domain) shipped alongside this release but aren't part of the desktop app,
  so they aren't itemized here.

## v2.0.0 — 2026-08-02

197 commits since v1.0.10, 307 files changed (+25,309 / −3,589).

### Added

**Resource diagnostics**

- A Rust `resource-monitor` sidecar (built on `sysinfo`, wired over NDJSON with
  supervised retry/backoff and a handshake watchdog) walks the app's process
  tree by PID and reports CPU/memory footprint per process.
- Settings gets a new Diagnostics page: footprint tiles for the app's overall
  resource use plus an expandable process tree, with a degraded banner when the
  sidecar is unavailable.
- The service samples on a cadence with a fast tier for the focused window and
  a slower tier for background ones, capping its NDJSON buffer and stopping
  cleanly on quit or when a subscriber window closes.

**Unified header and case chrome**

- The main window is now frameless top to bottom: the old 32px title-bar strip
  is gone, window caption buttons are drawn in React over new `window:*` IPC,
  and the header IS the title bar (chrome collapses from 80px to 48px).
- The case view's top bar and case header merge into one `TopBar`, with a
  `caseBarStore`/`CaseAnchor` seam carrying the session switcher, chat search,
  find, and chip state; Settings gets a matching page masthead.
- The case workspace now lays out three peer columns (evidence rail, chat/
  panels, findings) on one ground plane, with docked native panels inset to the
  case card's rounded corners; Jira integration moves out of the bar into an
  always-open two-line panel on the evidence rail (title, sync stamp,
  attachment count) that decays back to a resting state after a sync.
- Recent-case tabs, PR/CI checks, and review controls are bounded to a fixed
  share of the bar so the action icons stay reachable regardless of how many
  cases or checks are open.

**Light theme**

- A full light theme ships alongside the existing dark theme: a cool wash
  palette and viewport-anchored ambient ground, with the dark theme's tokens
  pinned so neither skin bleeds into the other.
- Every major surface — shell, home, case-view cards, Settings, the editor
  window, dialogs and dropdowns — moves onto a shared `surface-card`/frosted-
  overlay material so light and dark stay visually consistent through one set
  of tokens instead of per-component overrides.
- Dialogs, menus, and the command palette get theme-aware frosted glass in
  light mode while staying flat/solid in dark, per the project's decision to
  leave the dark theme untouched for now.

**Case phase model**

- A case's phase (analyzing, PR created, reviewing, RCA drafted, closed, ...)
  is now derived from its own newest work event — evidence, turns, PR/review
  activity — instead of being tracked as a separately-set status.
- The one phase with no derivable signal, RCA-drafted, can still be pinned
  explicitly; open/closed remain the only status values settable directly, and
  `update_case_status` now routes each phase value to the right mechanism or
  explains why it can't be set that way.
- Dashboard and case cards render the derived phase and filter/count off it;
  cards also gained a full pull-request glyph (merges, conflicts, drafts) fed
  by the cached PR/CI status, plus a context line summarizing totals and items
  needing attention.

**Composer: model catalog and run options**

- The composer now offers the CLI's real, currently-reported model catalog
  (including newly available models like Opus 5) merged with the app's
  built-in list, instead of a stale hardcoded set — so the picker no longer
  drops models mid-session and still works offline.
- The single fused option chip is replaced with one real chip per model
  capability (Reasoning, Context Window, Fast Mode, permission mode, ...),
  which varies by model and collapses into one popup menu on a narrow window
  instead of overflowing.
- "Ultrathink" is now a one-click prompt prefix, with read-back and a body
  lock so it can't mangle a message that already contains the word, and a
  prominent stop button replaces the previous barely-visible stop link.
- Run options and permission mode now persist per session and rebuild the
  session when changed.

**Dynamic theme, continued**

- The case view's header and case-id group now carry their own dynamic-theme
  scope, and dashboard case cards get a directional top-right glow falling
  into a darker bottom-left corner, shared between the classic and dynamic
  skins from one set of tokens.
- Several dynamic-theme correctness fixes: a dark-only ambient guard was
  rendering black under light+dynamic, stale `--surface-*`/`--bg-deep` tokens
  were retired in favor of the shared material, and glass overlays now
  composite over the ambient wash instead of replacing it.

### Fixed

- Model picker: the runtime catalog was substituting for, rather than merging
  with, the built-in model list, silently dropping Opus 4.8/4.7 and Sonnet 4.6
  a few seconds after launch.
- `listCases` had no total order and could return cases in a different
  sequence between calls.
- IPC no longer leaks Electron's raw `invoke` wrapper text into user-facing
  error messages.
- Popups and select menus unified onto one opaque overlay material (the
  composer's model menu was nearly transparent before); Library action rows no
  longer stay lit after a click; the Run-review and Jira case popovers no
  longer clip their first line of text.
- Settings reorganized: Confluence pairs with the HiveMind repo under a new
  Team page, and Sources becomes packs-only under System.
- A click on a hover-opened submenu no longer immediately closes it; docked
  native-view panels are now occluded correctly behind component-level
  modals, not just page-level ones.
- Several inert-token fixes: the PR-draft input, case-view masthead weight,
  and the dynamic theme's muted text color were all wired to tokens that
  emitted no CSS.
- The review-mode switch no longer greets you with a raw `gh` command dump.
- PR/CI polling now suspends while the window is hidden.
- Default window minimum size raised to 1280x800 so the case workspace's
  three columns no longer get forced to their clamp widths.
- New app icon artwork regenerated across every platform surface (Windows
  `.ico`, macOS `.icns`, Linux/build PNGs).

### Internal

- Claude SDK floor raised to 0.3.220 to pick up Opus 5, with a captured real
  model-catalog fixture for tests.
- The two sample packs (`sample-bridge-playground`, `sample-external-app`) are
  no longer seeded into dev/test installs; they moved to a separate
  `demo_pack` repo as real installable/updatable packs so the pack-update
  feature has a live target to check against.
- Diagnostics sidecar build/staging, protocol, and CDP-gated acceptance
  tests; several whole-branch review passes across the header, case-bar,
  case-phase, dynamic-theme and light-theme branches fixed cross-task
  regressions before merge.

## v1.0.10 — 2026-08-01

142 commits since v1.0.8, 197 files changed (+20,459 / −1,108). v1.0.9 was tagged
but never published as a release; its changes are folded in here, and the version
number jumps straight from v1.0.8 to v1.0.10.

### Added

**Core auto-update**

- electron-updater backend wired to a GitHub publish provider; a
  `CoreUpdaterService` state machine (`UpdateStatus` vocabulary) drives the IPC
  surface, preload API, and a boot-time check.
- Settings → General update block and an app banner reporting phase and progress,
  with dismissal re-keyed on phase+version and a permanent error sink surfacing
  restart failures.
- `docs/releasing.md`: the release runbook — draft-release publish step,
  `latest.yml` gate, and the Windows-unsigned posture.

**Pack updates**

- Manifest `updateUrl` with trust-on-first-use origin pinning; an update-feed
  schema and compatible-version selection; origin-pinned update check and apply.
- Packs page: per-pack update status over IPC, update affordances, a relaunch
  prompt after apply, and feedback when a check finds nothing.
- `pack-tools`: an `argus-pack feed` command and update-feed authoring docs.

**Dashboard and card polish**

- Redesigned case cards: neutral priority pill, glowing status dot, icon+number
  metrics, CI glyph, sync badge, clamped two-line title.
- Dashboard: status/priority filters, search affordance, drawn checkbox, sync
  icon, counts below the wordmark.
- New shared primitives: `StatusDot`, `PrRollupIcon`, `SyncBadge` (health + age).

**Editor: tabs, read-only tiers, and restore**

- Tab strip with overflow dropdown, roving-tabindex keyboard nav, and announced
  dirty state, backed by a pure tab reducer with rename-aware dedupe.
- Protected assets open read-only with a working "Edit a copy"; asset tier
  resolved from the lists already broadcast to every window.
- The open tab set, cursors included, persists beside window bounds and restores
  after a restart through one ordered message queue.

**Editor: command palette, quick open, and find references**

- A pure command registry backs the toolbar, the window keymap, and a single
  command palette (opened with a `>` prefix) shared with asset quick-open;
  palette rows and sections are pure functions of the query.
- Quick open runs a dependency-free fuzzy scorer over an asset corpus assembled
  in main, where the files live; the openable-asset list includes drafts.
- Markdown links resolve against the reference set and open on Ctrl+click; a
  "Find references" pane beside Problems shows what mentions the current file
  (`INDEX.md`, being generated, opens read-only and says why).

**Frameless window chrome**

- The main and editor windows now construct frameless, sharing a title-bar
  overlay module that re-tints on every theme change and scales for zoom.
- The main window's TopBar is the drag region; the editor window gets its own
  title strip and now collapses to one row of chrome, with the tab strip flush
  to the window edge.

**Dynamic theme, case view and Settings**

- Case-view materials: lit band, glass header, per-variant band geometry.
- Settings: panel material on cards, nav rail to ground, and a page masthead with
  title and blurb.

### Fixed

- PR companion: cancelled checks no longer read as failures.
- Pack update pipeline hardened end to end: bundle identity verified, off-origin-
  only updates distinguished from no update at all, downloads streamed, writes
  reject rather than hang on failure, bundle id/version validated at
  feed-publish time.
- Editor: save-order, read-only coverage, and render-cost fixes from a
  whole-branch review pass; `skills:changed` now broadcasts on fork so a forked
  copy isn't stuck read-only. A second whole-branch review pass closed command-
  registry gaps, fixed a negative SECONDARY multiplier that inverted quick-open
  ranking, and replaced a backtracking markdown-link scanner (and its O(n²)
  destination scan) with a linear one.
- Frameless chrome: the runtime gate now reaches the Library instead of passing
  vacuously, the titlebar inset floor is platform-aware, and the drag strip's
  background matches the native overlay.
- Update service: re-entrancy guard on `check()`, non-`Error` rejection handling,
  lint cleanup.

### Internal

- The build workflow's release job now sources its notes from this file's
  per-version section instead of `gh`'s auto-generated PR-title list, and fails
  the release if a tag has no matching section.

## v1.0.8 — 2026-07-31

391 commits since v1.0.7, 397 files changed (+39,150 / −1,546).

### Added

**Distillation feedback loop**

- **Reject reasons.** Rejecting a proposal on the Proposals page can now stamp an
  optional reason (overfit / overgeneric / wrong / duplicate / other, plus a one-line
  note) into the archived proposal's frontmatter as `reject_reason`/`reject_note`.
  Applies to all proposal rejects, distiller-produced and contribute-back alike.
- **Prompt versioning.** `distill_jobs.prompt_hash` is a 12-char sha256 over the
  case-distill prompt's static parts only — the distill contract and section header
  texts, as resolved through the prompt registry at enqueue time.
- **Eval-bundle export.** A dev-gated action on the hidden Prompts page exports each
  case's latest fully-reviewed distill job as NDJSON: input snapshot, raw output,
  prompt hash, and per-item accept/reject outcomes with reject reasons. Accepted
  items are included as positive controls, parse-failed jobs as eval cases. Nothing
  is uploaded; the file goes where the user's save dialog points.
- **Distill-eval harness.** A new package at `tools/distill-eval/` replays corpus
  cases through the real `buildCaseDistillPrompt`/`parseCaseDistillOutput` (bundled
  via esbuild), reuses stored output when the prompt hash is unchanged, runs
  candidates via the `claude` CLI (prompt over stdin), and LLM-judges old-vs-new per
  item against the human reject labels (verdicts improved/unchanged/regressed/
  needs-human), emitting `report.md` and `details.jsonl`.

**Layered code review and PR write-back**

- A data-driven review-layer registry compiles into driver-neutral subagent
  definitions, fanned out per layer where the backend supports subagents (Claude and
  Copilot so far); findings now carry a layer, a severity, and a diff anchor pinned
  to their first citation, with a layer filter and severity badges in the findings
  pane.
- Two new review-action tools, both stopping at the existing human-approval card:
  `post_review_comment` (MEDIUM, editable body) posts a finding as an inline PR
  comment, and `push_review_change` (HIGH, non-editable) applies a finding's
  suggested change and commits/pushes it to the PR head branch. A batch-apply flow
  lets several selected findings push in one turn. All `gh` access now goes through
  one thin seam (`services/github.ts`).
- One pull request per case, enforced by a unique index on `pr_bindings` — a finding
  can only cite `repo/path:line`, never a PR number, so several bindings per case
  made a finding's target PR unknowable. Manual linking (url, `owner/repo#N`, or bare
  number) and automatic discovery both replace the case's single binding, with a
  picker that pre-selects non-backport PRs and guards against replace/race hazards.

**PR and CI status companion**

- One batched GraphQL call per refresh populates a `pr_status_cache` row per case,
  feeding a rollup dot on the case header and every dashboard card, a divided
  checks panel in the review-mode companion section (required vs. non-blocking,
  cancelled runs bucketed separately), and GitHub's own merge-state text.
- `fetch_check_logs`, a LOW auto-run tool, pulls a failed check's Actions job log and
  ingests it as evidence (origin `ci`), and a composed turn drives CI-failure
  analysis from it. The poller idles rather than stops once a run goes terminal, so a
  restarted check is still picked up.

**Evidence scoped by mode**

- Evidence and artifacts now live under per-mode directories with shared scope
  vocabulary (`investigation` default, `review` for PR review mode): ingest, rescan,
  watch, search, and the files pane all route by the session's active mode, and
  review-mode evidence is relabeled "Code review artifacts" with search hidden.

**Editor window, increment 2**

- The single-editor-window shell (increment 1) now hosts a real editor: CodeMirror
  replaces the old textarea, with a YAML-frontmatter-aware markdown mode, app-token
  theming, a persisted font size/wrap and the spec's keymap, a problems panel wired
  to validation, and a status bar with sync state.
- A hashed-key draft store with atomic writes/discard autosaves through main, with a
  banner state machine for stale/colliding/conflicting drafts and a shared `DiffView`
  used for assist review, staleness, and save conflicts alike. A split preview pane
  with a draggable splitter and proportional scroll sync rounds out the window.
  CDP-gated tests cover draft flush/restore across a quit and undoable-assist accept.

**Dynamic theme — ambient canvas**

- A "Dynamic theme" toggle in Settings > General turns on a raw-WebGL2 aurora
  background (`AmbientCanvas`) behind the dashboard, plus glass variants of `Card`
  and `CaseCard` (ring/sheen layers, a priority-tier rail with stagger, and a
  `useGlassPointer` cursor-tracking hook for the highlight). Scoped CSS tokens keep
  the effect confined to the dashboard's `DynamicHome` wrapper.

**Library rights-groups and asset authoring**

- The Library's five origin tiers are now presented as three rights-groups, with
  badges that name the actual origin instead of a tier id and an overrides chip using
  the same vocabulary. Claim and update-available surface directly on library rows.
- `AssetEditor` gained real validation, a live preview, and LLM-backed Draft/Improve
  assist (via the headless runner, provider-blind); a New menu, inline Edit, and
  fork-then-edit ("Edit a copy", with rename) replace the old flow, all opening in the
  editor window rather than an in-page modal.

**Authorship trail**

- Skill, reference, and proposal writes are now stamped with author/origin/
  contributor frontmatter (day-resolution, YAML-safe, merged so the on-disk file
  always owns the byline). The Library viewer and Browse rows show who wrote and who
  forked an asset.

**HiveMind update safety**

- Before an update or download can overwrite a local asset, `localDivergence` detects
  unpushed edits and a shadowing check (`shadowedByUser`) warns when a user's fork
  would keep shadowing an upstream update, showing what the overwrite would discard.
  Push now happens from a throwaway worktree so a hive clone's HEAD never moves, and
  a tier restamp is reported independently of content divergence.

**Synthetic seed data**

- A new `scripts/seed` orchestrator materializes a realistic ARGUS_HOME for manual
  verification: cases/sessions/turns, evidence and artifact trees, proposals and
  every skill/reference tier, distill jobs in every state, a findings matrix covering
  every severity/layer/state combination, and a cloned test repo with a worktree per
  pull request — all with self-verifying invariants and a refusal to run against a
  real ARGUS_HOME.

**Release and CI**

- macOS releases are signed with a Developer ID and notarized in CI, so the app opens
  without a Gatekeeper right-click; the DMG is submitted and stapled separately from
  the `.app`.
- CI now runs typecheck, lint and tests on every push to main (not just Windows), and
  test budgets get CI-conditional headroom to stop starved runners from flaking.

### Changed

- The findings pane was reworked around severity-ranked rail cards with hover-reveal
  actions and a selection footer for batch apply, and is keyed by case slug so
  switching cases can't leak stale findings.
- Loading states across evidence, findings, repos, and the PR section now share
  pending-state hooks and skeleton primitives, and a rejected reload keeps the
  last-known list instead of clearing it.
- PR worktree setup runs faster: linked repos are described in parallel and the PR
  head is probed with `ls-remote` before fetching.
- Claude Code's built-in auto-memory subsystem is now disabled for Argus sessions —
  it was writing "remember this" notes to `~/.claude` instead of Argus's own
  `write_memory`, invisibly to the Memory settings page and to bundles.

### Fixed

- **Drafts.** Create-mode drafts are now keyed by a stable id instead of the typed
  name; a legacy draft is adopted atomically (never delete-then-write); resuming a
  draft that shares the open tab's name remounts the tab instead of showing stale
  content.
- **Build/CSP.** Vite no longer inlines a font the packaged app's CSP blocks; zod's
  JIT probe no longer trips the renderer CSP.
- **Review mode.** Several PR-binding and citation hazards closed: ambiguous PR
  citations are rejected instead of guessing, the picker's replace-confirm can no
  longer be bypassed by a case switch or an overlapping search, and citation/preview
  resolution recognizes remote-derived repo names.
- Mermaid diagrams no longer flicker while a message is still streaming in.
- Theme changes now propagate to every open window, not just the one that changed
  them.

## v1.0.7 — 2026-07-27

126 commits since v1.0.5, 199 files changed (+19,872 / −473).

> v1.0.6 was tagged but never released; its single change (the delete-performance
> work) ships here.

### Added

**Two new agent backends**

- **ACP driver (Cursor + Grok).** Driver kinds and a shared model catalog, a
  `session/update` → `AgentEvent` normalizer verified against captured fixtures, a
  library-isolating client wrapper with a test fake, permission-kind mapping tables
  with a fail-closed taxonomy, per-agent Cursor and Grok profiles (argv, model
  resolver, post-init model-set seam), and bounded `probeAuth`. Registered with the
  shared driver contract suite.
- **Codex app-server driver.** JSON-RPC stdio client with approval-request routing,
  a multi-pass-aware notification normalizer, approval/decision mapping tables,
  `runHeadless` one-shot for distillation, and bounded `probeAuth`. Defaults to
  global `~/.codex` auth (`CODEX_HOME` only when explicitly overridden). Registered
  with the contract suite.

**Mode axis — multi-role workspace**

- Mode registry with availability rules; sessions are pinned to a mode at creation
  via an additive migration, and each case carries an active mode.
- `roles:` frontmatter tag plus `rankSkillsForMode` (ranks, does not filter), feeding
  a mode-scoped skill index into the system prompt.
- Base persona split into a neutral core plus a triage fragment; persona and ranked
  skills are assembled from the session's mode, and a live session is rebuilt when
  its mode changes.
- Mode switcher in the case header, gated by available modes, that follows the switch
  to that mode's chat.

**PR binding and review mode**

- `pr_bindings` store; review mode unlocks once a repo is linked.
- Manual PR linking by url, `owner/repo#N`, or bare number, plus automatic discovery
  that searches linked GitHub repos for the ticket key.
- PR-specific case worktrees with an explicit PR-ref fetch, materialized on
  review-mode entry and surfaced to the agent.
- PR chips with link/unlink in the repos rail, and a PR picker on review-mode entry
  that pre-selects non-backports.

**Prompt surface (dev-only)**

- Registry of 25 editable and 3 external prompt entries behind a dev-tools gate, with
  a resolve-only `PromptStore` and catalog projection. Persona, skill index, memory
  header, tool descriptions, distill contracts and case rules all resolve through it.
- Prompts page with the prompt catalog and a composed-persona preview rendered
  through the real `assembleMode`, over gated catalog/preview IPC.
- Prompt overrides: a gated override file feeding `resolve`,
  `setOverride`/`clearOverride`/`clearAll` with validation, edit/revert/reset from the
  catalog, a change broadcast so other windows refresh, a boot log and a persistent
  override banner.
- Session prompt capture: a gated, ring-buffered capture store, a `capturePrompt`
  seam with a contract invariant every driver must satisfy, assembled and persisted
  captures, gated list/read IPC, and a session-capture tab that warns loudly when a
  prompt was dropped.
- Coverage guard: every model-facing literal must be registered or explicitly
  deferred, so a new unregistered prompt fails the suite. `deferred.ts` retired.
- `systematic-triage` and evidence-based `code-review` persona method blocks, with
  bundled skills.

**Mermaid diagrams in chat**

- Lazy `renderMermaid` library with strict security settings and theme-mapped colors.
- `MermaidBlock` with a streaming gate, error fallback and lightbox; mermaid fences in
  `MessageView` route through it.
- `DIAGRAM_FRAGMENT` persona guidance wired into every mode.

**Provider instance removal**

- Remove a provider instance from settings, cascading to `distillProvider` and
  `activeInstanceId`. Removal of the last remaining instance is refused, guarded at
  the mutation site; instances whose driver is unavailable can still be removed.

**Other**

- `systemPromptTransport` declared per driver, making the ACP system-prompt drop
  explicit.
- Landing page.

### Changed

- Mode-switch progress is shown on the control itself rather than in a floating toast.
- Chat transcript pins to the bottom on open and on session switch.

### Fixed

- Deletes no longer full-scan: FK cascades are indexed and FTS gets rowid map side
  tables (originally tagged v1.0.6).
- Stale streaming flag cleared when hydrating a mid-stream event log.
- Jira: an expired token is refreshed in `resolveSiteUrl`.
- OAuth: interactive authorize recovers from a revoked `refresh_token`.
- Modes: stale availability, a stuck switch error, missing feedback on a slow switch;
  chat selection reconciles with case mode and demotes when the last repo is unlinked;
  new sessions bind to case mode and `active_mode` is normalized.
- Prompts: overrides are written to disk before being adopted in memory, so a failed
  write cannot leave invisible live state; failed override saves and failed clear-all
  surface instead of failing silently; path-traversal holes closed in capture
  read/record; capture is honest about pack/connector reach and fragment sizes.
- ACP: turn.completed is emitted and interrupt is scoped per turn so permissions
  survive a stop; child stderr is drained, update delivery takes a single path, and
  `stop()` teardown is hardened.
- Codex: the persona `systemAppend` is forwarded to `thread/start`; headless declines
  approvals with generation-aware vocabulary.
- Diagrams: thumbnails scale to fit the height cap and the lightbox sizes to the
  viewport.

## v1.0.5 — 2026-07-24

- Jira zip attachments auto-extract into per-file evidence on ingest, via a new
  `archiveExtract` module with a traversal guard, size/count/ratio caps and a
  nested-zip depth cap. Extraction is gated to real `.zip` files and all entries count
  toward the cap.
- Resolution-aware distill rules and a confluence-tier reference guard.

## v1.0.4 — 2026-07-23

- **Knowledge hub.** Grouped sidebar with new Library, Team and Sources pages; legacy
  page ids kept as aliases; feature tour re-anchored. Pre-hub Skills and References
  pages removed.
- **Proposals** is a first-class settings page with a pending badge, a
  `proposals:changed` broadcast carrying pending counts, multi-select type-filter
  chips, live updates when proposals are dropped in externally, and pending-proposal
  banners on the Skills, Memory and References pages.
- **Share-in-place.** Sharing moved off the HiveMind Share tab onto the item itself
  (user skills and pushable references), with PR receipts persisted in
  `hivemind-state.json` and a share hand-off from accepted proposals.
- **Library.** Unified rows via `SettingRow`, openable skills through a `skills.read`
  IPC, a `deleteRef` IPC for hand-owned references, kind/tier filters with unified
  search, and hover-revealed Delete/Remove on every removable row.
- Single shared trust-tier module with `TierBadge` provenance chips on skill,
  reference and hive rows.
- macOS: the claude probe and headless runs pin their cwd to tmpdir, which stops
  random TCC prompts.
- Copy and visual sweep — Install/Uninstall became Download/Remove, destructive
  buttons are solid red — plus onboarding tour fixes, a home-icon top bar and a
  submenu hover-gap fix.
