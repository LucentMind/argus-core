# Changelog

## v1.0.8 — 2026-07-30

9 commits, 37 files changed (+3,558 / −17).

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
