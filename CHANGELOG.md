# Changelog

## v1.0.9 — 2026-08-01

91 commits since v1.0.8, 153 files changed (+13,178 / −888).

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

**Editor window, increment 3**

- Tab strip with overflow dropdown, roving-tabindex keyboard nav, and announced
  dirty state, backed by a pure tab reducer with rename-aware dedupe.
- Protected assets open read-only with a working "Edit a copy"; asset tier
  resolved from the lists already broadcast to every window.
- The open tab set, cursors included, persists beside window bounds and restores
  after a restart through one ordered message queue.

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
  copy isn't stuck read-only.
- Update service: re-entrancy guard on `check()`, non-`Error` rejection handling,
  lint cleanup.

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
