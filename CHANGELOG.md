# Changelog

## Unreleased

229 commits since v2.3.0, 319 files changed (+29,709 / −1,818).

### Added

**Unified currency: one survey/apply pipeline for Core, Packs, and HiveMind**

- A new "Keep everything up to date" master toggle (Settings → Updates)
  replaces three previously separate update mechanisms with a single
  periodic survey that checks Core, every installed pack, and the
  HiveMind repo on one schedule, with per-adapter backoff anchors
  persisted to disk so a missed check catches up instead of waiting out a
  fixed interval. The toggle governs only whether *clean* candidates (no
  dependency change, no trust-tier change, no local edits) apply
  automatically — it never governs whether the app checks; Packs/HiveMind
  Settings and the manual "Check for updates"/"Sync" buttons always
  survey on demand, rate-limited to the same poll interval.
- Applies run behind an app-quiescence gate (no active agent turn, no
  running routine, an idle ingest queue) and a single apply lock shared
  with the manual Update/Install buttons, so a background auto-apply and
  a button press can never interleave. Core drains unconditionally ahead
  of the quiescence check, since it only writes into the updater's own
  cache; Pack and Hive writes touch files the app may be reading, so they
  wait for a quiet moment and re-check quiescence between each item.
- A settings status line reports "not checked yet / everything current /
  N items held back" from one payload, hydrated exactly once and shared
  by every surface (TopBar, nav, Settings pages) instead of each racing
  its own fetch.

**Per-adapter safety rules**

- Core stages an update in the background but never force-restarts the
  app — the user finishes it on their own schedule, and a stage is only
  reported ready once its bytes are actually confirmed present.
- Packs refuses to auto-apply any update that would add a new dependency;
  that always surfaces as a held-back item requiring explicit approval.
- HiveMind mirrors the repo and re-derives its own installed/pinned state
  from the clone before writing, rather than trusting a stale snapshot,
  and shares its write lock with manual installs so a background survey
  can't race a user-initiated pin change.
- A two-strike grace covers auth and not-found GitHub failures — GitHub
  answers a private repo and a transient permission/SSO blip identically,
  so the first sighting is withheld and only a second consecutive failure
  badges the user; a missing GitHub CLI install is deterministic and
  surfaces immediately.

**Held-back reasons, badges, and nav dots**

- Anything currency withholds — local edits, a trust-tier change, a new
  dependency, an auth or sign-in problem, a not-found repo, a downgrade,
  an origin mismatch — renders from one shared sentence-writer, so the
  wording can't drift between the Packs and HiveMind pages.
- The Settings button and the nav rows that own held-back items get an
  attention dot; Packs and HiveMind each get a section badge and per-item
  reason line, with Skills and References badged separately rather than
  lumped under one "Repository" count. Dots and badges go quiet entirely
  when the master toggle is off, and republish immediately when it's
  flipped rather than showing stale state until the next survey.

**First-run HiveMind mirror notice**

- The first time currency mirrors brand-new HiveMind content (not
  updates to things already installed), a one-time notice in the case
  header reports how many items were adopted — recovering as a pending
  count on next case-open, persisted across a restart, if no case was
  open when it happened.

**Multi-file skills**

- A skill in the Library can now carry sibling files alongside
  `SKILL.md` — scripts and other supporting assets, not just the one
  document. `write_proposal` can attach these files, and accepting a
  proposal writes the skill's whole directory atomically, preserving
  existing sibling files rather than deleting them even when merging into
  a HiveMind- or pack-tier skill with no local copy yet.
- The proposal review UI shows a file rail for a proposal that carries
  siblings, lets each file be reviewed and edited individually (edits
  carry through to what gets accepted), and renders non-Markdown files as
  code. A proposal that includes an executable is flagged on the queue
  card, and pushing a skill to the team through HiveMind names the
  executables it shares before you confirm.
- A skill's sibling files can be opened, edited, and saved as their own
  tabs in the editor, with per-file autosave and validation; a Files dock
  tab lists the active skill's siblings, and the `@` file picker opens
  one directly.
- Before the agent runs a script that's part of a skill, it's checked
  against that script's review state and — if not yet approved —
  surfaced as an approval card naming the script and its size, instead of
  running silently. Hardening closed several ways this gate could be
  bypassed: chaining an approved script with a second, unreviewed one no
  longer rides the first's grant; scripts referenced via a git-bash MSYS
  path or a `~`-rooted path no longer fall through to a silent allow; and
  multi-line commands and backslash line-continuations are now parsed
  correctly instead of missing the script reference entirely.

**Orphaned session history**

- A session can carry conversation history the model no longer has as
  context — after importing a case from another machine, switching
  driver, or switching provider accounts on a pinned session. A
  dismissible chat banner now surfaces this, and the next turn
  automatically replays a deterministic digest of the prior transcript.
  For drivers with native tool support (Claude, Copilot), a
  `read_session_transcript` tool lets the model page back through turns
  the digest had to omit, scoped to that session's own transcript.

**Settings reorganization**

- General's Theme/Dynamic theme/UI scale controls collapse into one
  Appearance row; RCA report settings move from Connectors onto Agent,
  its template editor now three nested disclosures instead of nine
  textareas at once; distillation spend moves to Agent → Background work,
  beside the provider and model that determine run cost; and Library
  section subtitles move onto their header lines.
- "Re-run checks" on the Sources page becomes "Re-check N failed" and
  only re-probes the tools that last failed; the Jira clone-link-types
  row now offers a picker over the connected site's own link-type
  catalogue instead of free text.

**GitHub issues as a case source**

- A case's ticket is no longer assumed to be Jira: a new ticket-provider
  registry (a Jira provider and a gh-CLI-backed GitHub issue provider,
  resolved by id) is the sole authority on which tracker a case belongs
  to, recorded explicitly on the case rather than inferred from the ref's
  shape. A case can now be created directly from a GitHub issue,
  alongside Jira.
- A GitHub-bound case can be refreshed like a Jira one, and correctly
  follows an issue transferred to another repo — the case rebinds to the
  new ref and its existing evidence moves with it instead of forking into
  a duplicate copy. Linked-PR discovery now asks GitHub's own
  issue-linkage data for a GitHub case instead of running a Jira-shaped
  search that silently returned nothing.
- An RCA report can now post to a GitHub issue as its destination, not
  only Jira — one comment carrying the executive summary plus the full
  technical report in a collapsed section, since GitHub has no
  comment-attachment API. The post-confirm dialog warns when the target
  repo is public or its visibility can't be confirmed. The case UI names
  which tracker a case's ticket actually resolved through (case card, New
  Case dialog, RCA post target) instead of always saying Jira.
- Shipped with several whole-branch hardening waves closing real defects
  found by re-review: RCA drafts silently missing the issue body and
  comments for any GitHub ref, GitHub-bound cases displaying "Jira:
  closed" and posting RCA comments that called the issue a Jira ticket,
  and a zero-padded GitHub issue number (`#007`) now canonicalizing to
  the same ticket instead of reading as a different one.

**Slack connector with confidential-client OAuth**

- Argus's OAuth previously assumed a public, PKCE-only client; Connectors
  settings now supports confidential clients (client ID + secret) with a
  Slack preset, so Slack — whose OAuth requires a registered confidential
  client — can be connected. Statically configured credentials skip
  Dynamic Client Registration entirely once a client is pre-registered in
  Slack's own app console.
- The loopback OAuth redirect now binds both 127.0.0.1 and ::1 per RFC
  8252 §7.3, since the system browser resolves "localhost" independently
  of Node's own `dns.lookup` and may land on whichever loopback family
  Argus isn't listening on; a supplied redirect URL must now also name an
  explicit port, so the reported callback address can't silently disagree
  with the one actually bound.
- When a loopback redirect isn't reachable — remote or headless use — a
  "paste the code" fallback completes the OAuth exchange by hand instead
  of failing outright.

**Contentless evidence index**

- The evidence full-text-search index now tracks rows without storing
  the source text redundantly inside the index (a "contentless" FTS5
  table), rendering search snippets by reading the matched lines back off
  disk through a new locator map connecting each indexed row to its
  source file — a smaller, faster index instead of a second on-disk copy
  of every evidence file's text.
- Existing installations migrate in place, one evidence row at a time,
  entirely inside the database with no re-read of files from disk. Search
  keeps working throughout: it queries both the new and legacy tables and
  merges results until the migration finishes, at which point a finalize
  step drops the legacy tables and reclaims the freed disk space.

### Changed

- Expandable settings rows — Appearance, Default repositories, each
  provider, a pack's tools, the RCA report template — now expand from a
  click anywhere on the row instead of only from the chevron at its end.
  The row's own controls (enable switches, Update/Uninstall, "Set as
  default") keep their own clicks.

### Fixed

- A chained shell command running two skill scripts — one already
  approved for the session — could silently auto-run the second,
  unreviewed one with no approval card; a related hole let a skill-asset
  grant apply to a base command the classifier had deliberately left
  grantless.
- Accepting a proposal against a HiveMind- or pack-tier skill with no
  local user copy could discard the true author's frontmatter and
  contributor trail, or drop that skill's existing sibling scripts
  entirely.
- Toggling a proposal's view between edit and diff mode could silently
  discard an in-progress edit; the toggle now preserves the buffer, and
  discarding requires explicit confirmation.
- The chat transcript could yank a reader who'd scrolled up back to the
  bottom mid-turn; auto-scroll now only follows new output while pinned
  to the bottom.
- The pending-adoption count for the first-run HiveMind notice now
  survives an app restart instead of resetting to zero.
- A hold resolved by hand (e.g. installing from a file after an
  origin-pin block) clears immediately instead of waiting up to 6 hours
  for the next scheduled survey.
- A failed HiveMind sync now persists its error so the Sync button and
  status chip keep reporting it on later visits, with the message on the
  chip itself and no longer false-alarming on an unrelated later
  operation; "Download All" no longer un-declines every item previously
  removed, and uninstalling now leaves a tombstone so the mirror can't
  silently reinstall a deliberate removal.
- A background (non-manual) pack or HiveMind auto-install now broadcasts
  the same change events the manual buttons already did, so the Packs
  and HiveMind pages and the "relaunch to finish" prompt update live
  instead of only after a reload.
- Slack's OAuth quirk of returning HTTP 200 with an error payload instead
  of a real HTTP error code is now normalized into a proper OAuth error;
  a loopback-bind failure during authorization no longer deletes an
  existing connector's valid refresh token before a new authorization is
  even attempted; an emptied Slack scopes field now floors to Slack's own
  default scope set instead of requesting everything the SDK advertises;
  a token refresh with no stored refresh token no longer clobbers an
  in-flight paste-the-code exchange; and Dynamic Client Registration is
  now blocked when no Client ID is configured, instead of falling through
  to a confusing SDK error.
- One failing linked-PR lookup for a GitHub case (a deleted/private repo,
  a transient error) no longer discards every other linked PR alongside
  it.
- The evidence-index migration blocked the whole app for its duration on
  a large database (measured against a real 36.7 GB install): it moved a
  whole evidence row inside one synchronous savepoint and only yielded
  between rows, so a single large artifact could hold the event loop for
  seconds at a stretch. Atomicity moves to the chunk instead of the row —
  the migration now yields between chunks, matching how ordinary indexing
  already worked — and logs periodic progress so a long migration no
  longer looks like a hang.
- Finalizing the evidence-index migration (dropping the legacy tables,
  then running VACUUM) kept re-running to completion on every subsequent
  boot: the app's own schema setup was still recreating both legacy
  tables, empty, on every open, which fooled the "already finalized"
  check into thinking migration hadn't happened and triggered a full
  multi-gigabyte VACUUM at every launch. Once the tables were genuinely
  gone for good, several evidence-delete paths (delete evidence, update
  evidence content, Rescan, delete a case, a bundle-import rollback) began
  failing outright instead, since they queried the legacy tables
  unconditionally rather than checking whether migration had removed
  them; an interrupted VACUUM's freed disk space is now reclaimed on a
  later boot instead of being lost silently.
- A file that returned a read error while rendering a search snippet
  (e.g. a permission error, or the file vanishing mid-read) rendered a
  blank snippet instead of the missing-file marker.
- A distill v3 run now drops a single malformed candidate instead of
  failing the entire run and losing every other candidate alongside it.
- A HiveMind-synced reference from the Confluence subfolder read as
  permanently stale with no real update behind it, while its actual
  update indicator stayed invisible; removing a HiveMind-installed
  reference could also leave its pin behind under a different (namespaced)
  key, so the file silently reappeared on the next sync as if it had
  never been removed.

## v2.3.0 — 2026-08-19

41 commits since v2.2.0, 55 files changed (+5,121 / −341).

### Added

**Distillation dry runs and run detail**

- A "Dry run (compare)..." row on the case menu runs the full
  distillation pipeline against a case without staging proposals,
  overwriting the case summary, rewriting the global reject digest, or
  creating any assets — a safe way to compare the pipeline's current
  behavior against an already-distilled case's real run. `ignorePriorProposals`
  can also blank the case's own prior proposals for the comparison, since
  otherwise the duplicate veto silently drops nearly every candidate before
  the pipeline's actual behavior is exercised.
- A dry run is excluded from every read of a case's real distillation
  state — status, redistill-needed checks, eval export, and the Settings
  cost/usage stats — so a completed comparison run can never mask or
  inflate the case's own history. It still appears, clearly labeled, in
  the run picker for side-by-side comparison, and the chip distinguishes
  "dry run... X" from "distilling... X" while one is in flight.
- A new run detail panel ("Distillation details...", separate from the
  Distill row that starts/stops one) shows the verdict, drop breakdown,
  per-stage raw output, dropped-candidate table, and trajectory for
  whichever run is selected — newest first, dry runs included.
- Exporting an eval bundle can now target a specific chosen job instead of
  only ever the latest one per case, with a dev-tools job picker in the
  Prompts page; a pending-review or dry job is exported with an explicit
  warning or skip reason instead of silently vanishing from the bundle.

**Link a case to its source tickets**

- A case can now track related Jira tickets — "source" tickets — distinct
  from its own primary ticket: clone links are discovered automatically
  from a ticket's `issuelinks` (which link types count as a clone is
  workspace-configurable), and a source can also be added by hand. A new
  `case_jira_links` table backs list/add/unlink for a case's sources.
  Linking enforces that a ticket can't be both the case's own ticket and
  one of its sources.
- Linking a source ticket ingests its description text as evidence
  immediately, the same as the primary ticket; the New Case dialog can
  offer a cloned ticket's attachments up front when creating a case from a
  ticket that has clone links.
- Refresh now checks every linked source independently for new comments
  and attachments, scoped per ticket key so one source's state can't leak
  into another's; the refresh-attachments dialog groups results by ticket.
  Attachments the user explicitly declined on a source are remembered per
  source so they aren't re-offered on the next refresh.
- An attachment byte-identical to one already ingested from another linked
  ticket is deduped by content hash instead of creating a duplicate
  evidence row (and, for a zip, re-exploding it) — the dedup is recorded
  against the existing row and shown as "already on \<TICKET\>" next to the
  done chip.

**Source-ticket UI polish**

- The New Case dialog's clone-ticket rows collapse and re-expand instead
  of only ever expanding, hide a clone's summary line when it's identical
  to the ticket's own (which it normally is), and no longer wrap a long
  key across two lines.
- The case rail's "Add source ticket" shrinks from a full-width button to
  a Plus icon beside refresh (matching the section-level vs. row-level
  action split already used elsewhere), its unlink control switches from
  an X — which reads as delete — to an unlink icon, and a clone already
  linked as a source is no longer offered again in the add dialog.

### Fixed

- A dry run's broadcast could be adopted directly by the UI as if it were
  the case's real distillation state, at one point making the case menu
  claim "nothing to distill" for a case whose real run had actually staged
  items; a completed comparison run was also inflating the Settings
  distillation cost/usage stats. Both now read through the same
  dry-run-filtered path the backend already used elsewhere.
- A source ticket that gets renamed or moved no longer loses its link:
  `case_jira_links` now records the ticket's canonical key consistently
  with how its evidence is stamped, instead of a pre-fetch key that could
  disagree with it.
- An attachment the user never explicitly acted on was being reported once
  and then silently forgotten on the next refresh, because the diff
  advanced its baseline unconditionally; source refresh now matches the
  primary ticket's diff behavior exactly.
- A source ticket's comment-fetch failure is now surfaced instead of
  silently dropped, and own-ticket/source exclusivity is enforced at the
  data-access layer itself so every caller gets it, not just the one
  original call site.
- Importing a bundle now restores `case_jira_links`, and a corrupted
  `case.json` recovers its mirrored Jira source state instead of losing it.

## v2.2.0 — 2026-08-18

77 commits since v2.1.2, 191 files changed (+16,641 / −527).

### Added

- Argus can now follow a prerelease track. Settings → Updates gains a
  "Prerelease builds" switch: with it on, the app is offered builds tagged
  `vX.Y.Z-beta.N`, which are published as GitHub prereleases and are never
  offered to anyone on the stable track. A prerelease install is carried
  onto the next stable release automatically, with no need to switch back.
  Switching back to stable offers the current stable release even when that
  means going back a version — the way out of a prerelease that turns out to
  be broken, without reinstalling by hand. Such an offer is worded as a
  return to stable rather than as an update, and its button reads "Install"
  rather than "Download". The switch locks while a download is in flight or
  staged: those bytes install on the next quit regardless, so a control that
  appeared to cancel them would be lying.

### Changed

- The case distiller now picks a knowledge type by how the knowledge will
  be found again rather than by how large it is: a symptom-triggered
  procedure ("when X, do Y") becomes a skill, and durable facts consulted
  while executing some other procedure become a reference. Creating a new
  skill is now an expected outcome for a symptom class no installed skill
  claims, instead of a last resort — previously every new procedure landed
  in `references/`, because that was the only type whose creation path the
  contract spelled out. The old preference order still applies, but only as
  a tiebreaker when two types genuinely fit the same knowledge.
- Case distillation is now agentic. Instead of being handed a fixed
  digest, the distiller reads the case's own transcripts through its own
  tools (`list_sessions`, `search_transcript`, `read_transcript`) against
  a frozen snapshot of the case, and every proposal carries the `basis`
  it was drawn from. Its contract gained a preference order, a negative
  list, per-resolution caps, and free-text operator guidance you can set
  in Settings. Rejections now feed back in: a reject reason, note and
  date are kept, prior rejects are stamped onto later proposals, and a
  digest of reject patterns is built before each case job.
- Distill runs report what they cost. A successful run shows its token
  usage, cost and duration, and the same numbers are recorded per job
  alongside the model's trajectory and anything dropped.
- `tools/distill-eval` replays distillation against frozen worlds and
  judges the result against human accept-time edits, which are now
  archived as they happen to build that corpus.
- Case distillation can run as a staged pipeline. A new Settings row picks
  between `v2` (one agentic call) and `v3`, which splits the work into a
  cited dossier, then a summary and candidate set in parallel, then a veto
  pass, then materialization with validators. Each stage records its own
  prompt hash, usage and drops, so a bad proposal can be traced to the
  stage that produced it. `v2` remains the default until the two are
  compared on a real corpus with `tools/distill-eval --pipeline`.
- Packs can ship tool scripts. A new `run_tool_script` agent tool runs a
  generated stub against a loopback RPC server, so a pack's own tooling
  is callable from a session. The child is spawned with a scrubbed
  environment, a timeout and capped stdout, and the tools a script can
  call back into Argus are read-only. The script body itself is ordinary
  code running as you, so it is approval-gated like a shell command, and
  approving one script never approves the next — every script body is a
  different program. Background distillation, which has no one to ask,
  reaches the tool through its own whitelist instead.
- The `recipe` proposal type is retired. It routed identically to
  `reference-edit` and had gone unused since 2026-07-23. Recipes already
  accepted stay on disk and keep feeding the distiller's
  already-captured list; the type is simply no longer offered or accepted.

This rolls the case-distill prompt hash. Distill-eval rows recorded before
this release sit under the old hash and must be bucketed separately from
later ones, or the shift in proposal-type mix will read as model drift
rather than as the prompt change it is.

## v2.1.2 — 2026-08-15

5 commits since v2.1.1, 55 files changed (+1,911 / −551).

### Added

- The case grid gets a Sort menu beside the existing filters: alongside
  the default triage ranking, it can now sort by recently worked (a new
  `lastWorkedAt`, the latest turn actually run in any mode — not
  `updatedAt`, which also moves on a Jira sync or a tag edit) or by last
  update, either direction. Cases with no timestamp for the chosen field
  sink to the bottom rather than scattering to the top.

### Fixed

- Linking a PR from the picker, and switching into review mode, each
  blocked the UI on a `git fetch`/`worktree add` that was already
  best-effort by the time it started — the picker dialog locked itself
  with no progress shown, and review mode's few-second delay was actually
  an unrequested `gh search prs` call miscasting itself as a slow mode
  switch. Both checkouts now happen off the awaited path.
- Accepting a proposal could throw its row to the bottom of a group of
  same-timestamp proposals instead of leaving it in place, since the
  queue's sort wasn't a total order for ties from the same distill run.
- A hand-written reject reason can now actually be confirmed — typing one
  and pressing Enter (or a "Reject" button that appears once there's
  text) submits it; previously only the preset reason chips would submit,
  and the only remaining plain button silently discarded a typed reason.
- Pack dependency auto-install now runs on every path a pack's bytes can
  arrive by, not just the zip picker — installing from a GitHub repo, or
  applying an update that adds a new dependency, no longer refuses with
  "requires \<id\>" while silently skipping the dependency plan.

## v2.1.1 — 2026-08-14

63 commits since v2.1.0, 157 files changed (+9,825 / −784).

### Added

**RCA report templates and pre-post editing**

- Reports now render from a configurable template (separate exec/tech
  section lists, each with an id, heading, and instruction) instead of
  hardcoded sections, with shipped defaults editable in Settings;
  rendering is enforced byte-identical against the template, and a
  settings write to `rca.template` is atomic so a mid-write crash can't
  corrupt `settings.json`.
- Every RCA job snapshots the template it ran under at generation time,
  and the model brief, live preview, drop-sections list, and final
  confirm/render all resolve through that snapshot rather than whatever
  the template currently says — editing the template mid-flight can no
  longer retroactively change an in-progress job's structure.
- The model is briefed on the snapshot's sections and asked to return one
  entry per id; its output is validated against those expected keys, with
  per-section fallback to the legacy hardcoded fields so old and new
  reports keep rendering identically. The template editor supports
  rename, reorder, enable/disable, add/remove per report, and reset to
  defaults; section ids are globally unique across both reports, and a
  claims-typed section is rejected from the exec list at the schema
  level, since the exec report is contractually barred from showing
  citations, finding ids, or file paths to a non-technical Jira audience.
- A confirmed report's markdown can now be hand-edited before posting
  (warning before discarding unsaved changes) and individual sections can
  be dropped before confirming; hand-edited state is derived by
  re-rendering the confirmed structure and diffing it against the on-disk
  text, and the preview switches to the actual on-disk bytes once a
  report has been edited.
- Correctness fixes from the rollout: hand-edit detection now snapshots
  case metadata at confirm time instead of re-reading the live case, so
  linking Jira afterward no longer false-positives an "edited" state; a
  malformed on-disk structure file degrades to "not edited" instead of
  throwing; an in-flight disk read is now distinguishable from a
  genuinely failed one so the UI doesn't flash a false error; and
  re-posting a report whose comment already succeeded now tells the user
  plainly it won't re-send.

**Evidence ingest and indexing: no longer blocking or all-or-nothing**

- A new serial `IngestQueue` throttles per-file ingest work with real
  per-file and case-aggregate progress, and indexing itself now runs as
  an async, yielding operation instead of blocking the main process —
  both stages are abortable mid-file.
- A new `indexState` lifecycle field (pending/indexing/done/error)
  replaces the old binary indexed flag; the case file list shows a
  determinate per-file progress bar while indexing, a persistent "index
  failed" chip on error, and a bytes-weighted aggregate progress bar for
  the whole drop.
- Search results now carry a pending-index count alongside hits, so a
  search run while indexing is still in flight is never silently
  presented as complete. A boot sweep re-enqueues any incomplete ingest
  work, so a crash mid-index no longer leaves evidence permanently
  unsearchable.
- Hardening: a queue drain race that could strand a job at "pending"
  forever is closed and abort made unconditional; non-indexable rows
  (e.g. binaries) are still enqueued so their pack-extraction step
  actually runs, instead of being skipped entirely; and FTS index rows
  and their side-table map rows are now written atomically together, so a
  crash can no longer leave an orphaned, unreachable FTS row.

**Comment watermark**

- A new `applyWatermark` helper appends a configurable footer to
  AI-composed comments before they post externally, with independent
  enable/text settings per destination (Jira, GitHub) under a new
  "Comment watermark" section in Connectors settings.
- Wired into the RCA exec-summary Jira comment and into composed GitHub
  finding comments — applied once, before the inline/PR-level fallback
  split, so a 422 retry can't stack a second footer.

### Fixed

- Jira attachment picker (New case preview and the post-refresh selection
  dialog) gets select/deselect-all controls, with attachments grouped by
  type instead of raw upload order.
- The large-file viewer now reaches every line of very large files:
  Chromium's ~33.5M device-pixel layout ceiling was silently truncating
  the scroll spacer (a 1.8M-line file dead-ended around line 762K on a
  scaled display); the spacer is now capped at the measured real ceiling
  with scroll position mapped through the compression.
- Deleting a case now deletes its RCA job rows too — previously they were
  orphaned permanently, including the report body of a case whose row and
  on-disk directory were already gone — and existing orphaned rows are
  purged on next launch.

## v2.1.0 — 2026-08-13

20 commits since v2.0.12, 27 files changed (+2,828 / −133).

### Added

**Pack dependencies auto-install**

- Installing a pack that declares dependencies (v2.0.12) no longer just
  refuses on a missing one — Argus now resolves the whole transitive
  dependency set (each dependency naming its own update source, a feed or
  a GitHub repo) into a staging cache, without installing anything yet.
- The resulting plan is validated for coherence before anything touches
  disk: a chosen version must satisfy every requirement placed on it, not
  just whichever requirement resolved it first, and a dependency cycle or
  excessive depth is refused during planning rather than surfacing later
  as a broken load.
- PacksSettings shows the resolved plan — each dependency listed with the
  source its bytes come from, and a downgrade called out with a warning
  label instead of installing silently — and applies it in one action.
  Installing a single pack with no dependencies is unchanged; a multi-pack
  plan waits for "Install all". Applying installs dependencies before
  dependents and keeps whatever already landed if a later step fails, so
  the requesting pack is never left installed without what it needs.
- `docs/authoring-packs.md` and the `authoring-argus-packs` skill document
  dependency sources and the install-plan flow end to end.

### Breaking

- The object form of a dependency declaration (naming its own source) is
  pack API **1.2**, not 1.1 as v2.0.12 shipped it hours earlier. Folding it
  into 1.1 would have made that version number mean two incompatible
  schemas — worse, a 1.1-only Core would have kept matching an object-form
  pack during update selection, downloading it, and failing manifest
  parsing on every check, forever. Every existing pack's `^1`/`1`/`1.x`/`>=1`
  declaration still satisfies 1.2.0, so this costs nothing for packs
  already on 1.1.

### Fixed

- An already-installed dependency now resolves from its own recorded pin,
  not a dependent's declared source.
- A GitHub-sourced bundle is verified and has its pack API hydrated before
  planning, instead of being planned against stale or absent metadata.
- A race in claiming the staged plan before its first `await` could apply
  a superseded plan; a stale plan is now cleared as soon as a new install
  starts, and only once the new plan is actually about to restage it.
- A per-plan staging directory is now a real, owned temp directory —
  created after the root bundle's inspection succeeds and removed on
  supersession, refusal, or apply-completion — instead of one fixed,
  never-cleaned path that could leak downloaded bytes if a later step
  threw.

## v2.0.12 — 2026-08-12

92 commits since v2.0.11, 142 files changed (+12,596 / −487).

### Added

**Routines: scoped, per-item runs**

- A routine can now be scoped to a query instead of just running once
  unscoped: a `cases` scope sweeps your own cases (no cursor — it
  deliberately revisits anything touched since it was last looked at), and
  a `jira-jql` scope runs live JQL against Jira through a new JQL-search
  capability on the Atlassian client. A scoped run loops one turn per
  matched item, capped by `maxItemsPerRun` (default 10, hard cap 50), and
  persists a per-routine cursor so whatever doesn't fit carries over to
  the next run instead of being reprocessed or lost.
- Each item gets its own case (fetched and created, or adopted in place if
  one already exists for a Jira item) and its own turn, tracked in a new
  `routine_run_items` table with a per-item outcome. A new
  `propose_case_triage` tool lets the turn record a suggested title and
  tags against the item — never applied directly — which surfaces on Home
  as a per-item Accept/Dismiss action; the case carries a "Draft" badge
  tied to review state rather than to whether a routine created it.
- Marking a run reviewed now refuses while any of its drafts are still
  un-actioned, since reviewing the run is what removes the only place
  those drafts could ever be accepted or dismissed.
- Settings → Routines ships a pre-triage template, adoptable through the
  editor, as the reference example for the new scoped shape.
- Hardening from the rollout: JQL cursor stripping is quote-aware and
  formatted in the account's own timezone, a missing Jira `fields` block
  no longer poisons the cursor forever, an accepted suggestion no longer
  re-queues its own case, stranded item rows are reconciled after a crash,
  a case-slug rebuild no longer cascade-deletes its item rows, and
  quitting the app now genuinely interrupts a live item's turn instead of
  abandoning or mislabeling it.

**Evidence rail: collapsible sections**

- The Ticket, Repos, Pull request, and Related history sections of a
  case's evidence rail can now each collapse independently, with
  per-section collapse state persisted so it survives switching cases.
- Clicking something inside a collapsed section's body auto-expands the
  section first, rather than silently doing nothing.
- A layout fix stopped the upper rail box from squeezing the evidence
  list down to its minimum floor height on a tall rail.

**A new "auto" permission mode, with refusal handling**

- A new `auto` permission mode — the Claude CLI's own classifier-driven
  approval — joins the shared mode list, restricted to the Claude driver
  only. Because the CLI skips `canUseTool` entirely under `auto` (the same
  seam-skipping behavior as `bypassPermissions`), unattended and routine
  runs downgrade it to the default mode, matching the existing
  bypass/acceptEdits downgrade from an earlier release.
- `session.started` now carries the CLI's actually-adopted permission
  mode; Argus compares it against what was requested and records a
  per-provider-instance refusal when an org policy silently downgrades a
  session. The composer offers `auto` on Claude sessions and disables any
  mode the CLI has refused this session, exposing the reason via
  `aria-describedby` so it reaches screen readers, not just a hover
  tooltip.
- A tool-call audit path now records calls the Claude SDK auto-approves
  without ever calling `canUseTool` (under `auto` or a working
  `bypassPermissions`), gated on the CLI's reported effective permission
  mode and backed by a fixture captured live against the installed SDK
  rather than a guessed string match. Enforcement — denying calls under
  those modes — is out of scope for this pass.
- Several sync fixes keep the requested/adopted/reconciled permission mode
  from drifting apart: `default` is never recorded as a refusal, a session
  re-pinned to a provider that doesn't support its current mode resets to
  `default` and the renderer reflects that instead of showing a stale
  chip, and mode refusals clear on an explicit provider refresh rather
  than evaporating on the next background poll.

**Packs: dependency enforcement**

- A pack manifest can now declare a `dependencies` field (id → semver
  range), and the pack API version bumps to 1.1; a pack that declares
  dependencies must require `argusApi: "^1.1"`, so an older Core refuses
  it outright rather than silently ignoring the field.
- Dependencies are enforced at install, uninstall, and update: install
  refuses a bundle whose dependencies are missing or out of range,
  uninstall refuses to remove a pack that an installed pack depends on,
  and updating a pack now blocks a new version that would break an
  already-installed dependent.
- Packs load in dependency order (a topological sort, not folder order),
  and a missing/failed dependency, a dependency cycle, or a duplicate
  binary id/detector type across packs each become a load error naming
  the offending packs, instead of the collision being silently resolved
  first-wins.
- `docs/authoring-packs.md` documents the full ten-permission panel
  bridge and the new `dependencies` field.

### Fixed

- Accepting a suggested triage merges tags by namespace instead of
  replacing the case's existing tags outright.
- A disabled weekly routine's schedule summary separates its days
  correctly, and the schedule stays visible inside one disabled-state
  chip instead of splitting into two.
- Popovers anchored near the right edge of the window (SessionChips'
  status popover, the composer's collapsed "..." menu) now grow left
  instead of clipping off-screen.
- An already-aborted turn signal now settles synchronously instead of
  arming a `timeoutMs` timer it will never need.

### Internal

- Fixed the pack-API version bump's fallout outside `app/` (the
  `tools/pack-tools` scaffold fixture) and an `InspectResult` test
  fixture for the new dependencies field.
- Fixed a flaky ACP client-exit test and excluded the scratch e2e driver
  from lint.

## v2.0.11 — 2026-08-09

59 commits since v2.0.10, 117 files changed (+7,023 / −1,554).

### Added

**Proposals is now a top-level view**

- Proposals moves out of a Settings sub-page into its own standalone
  master-detail surface, reachable from a badged TopBar entrypoint (Library
  and strip entrypoints escalate to it too); the old Settings ProposalsPage
  is deleted and its full test coverage ported onto the new view, a stale
  `settings`→`proposals` deep link is intercepted and redirected, and the
  product tour's Proposals step now targets the TopBar button.
- The detail pane offers unified, split, and proposed diff view modes plus
  inline edit and reject reasons, backed by a queue rail and an
  accepted-rows pane; a new file (no `current` to diff against) renders as
  formatted markdown instead of a diff toggle with nothing real to compare.
  Proposal filters are three icon-family chips — Skill, Reference, Case
  summary — each showing a summed count, rather than one chip per proposal
  type.
- View titles (Proposals, Related history, Settings) now publish into a
  shared header store and render in the TopBar itself instead of each view
  drawing its own title row, collapsing what used to be two stacked bars
  into one 48px header.
- A whole-branch review pass fixed real correctness gaps: sort order and
  IPC-payload trust were restored by fixing test mocks rather than adding
  production workarounds; pending now wins selection over a same-file
  accepted row and accepted rows dedupe against a shadowing pending one;
  the diff pane is clamped with `min-w-0` so long lines scroll instead of
  clipping; Home's knowledge-pending count now reads live off
  `proposalsStore` instead of a stale snapshot.

**Routines: review tracking, a Home inbox, and staying alive for the schedule**

- Every routine run now carries a reviewed/unreviewed state (existing
  history is backfilled as reviewed on migration), with a per-run
  mark-reviewed action wired through IPC and an unreviewed count computed
  by a direct query so it stays correct past the existing 50-row
  run-history cap.
- A case created by a routine run is tagged with that origin (existing
  routine cases are backfilled from the run table), shown on its case card
  with a per-case unreviewed-run tally, and surfaced in a new "unreviewed
  runs" inbox mounted above the case grid on Home — sharing one
  subscribe-and-reload store with the Settings Routines page and rendering
  run summaries as markdown.
- A system tray icon backs the app with a single-instance lock: its
  tooltip and context menu read "N runs to review" when there's a backlog
  (clicking that item focuses the window and jumps to the inbox), plus
  plain Open/Quit entries. A keep-alive setting toggle lets the app keep
  running in the background after the last window closes so a schedule can
  still fire, offered wherever a schedule is actually set; on macOS the app
  already never quits on last-window-close, so the setting does nothing
  there — a prior release worded it as if it did, and this one fixes the
  copy rather than pretending to change platform behavior.
- When an unattended run finishes with no window open, a system
  notification fires (skipping a merely-minimized window, and never
  showing a blank body when the summary's first line is empty); clicking
  it focuses or creates a window and pushes the inbox into view. Getting
  the click to reliably land on a freshly created window took two real
  race fixes: notifications are now held in a module-scope set so their
  click handlers survive garbage collection, and the focus-inbox delivery
  no longer guesses a deferral point — main leaves a pending flag when it
  has to create the window, and the renderer consumes it once on mount
  instead of racing a push against its own effect subscription.

**Settings polish**

- The Connectors page now lists GitHub first, ahead of the MCP list — it's
  the connection every case depends on for PR lookup, pushes, and
  HiveMind.
- The knowledge-flow sentence on Settings' host pages (Proposals, Library,
  Team) becomes a status strip showing your current position across three
  steps, with the active step sharing the same highlight treatment as the
  settings sidebar's active nav item.
- 16 of 20 `loading…` sites across Settings became reserved-space
  skeletons; the remaining four stayed as words because they report an
  in-progress action rather than standing in for content.
- Theme and the Observability dashboard move out of the TopBar: theme now
  lives in Settings only (with a System option that follows the OS live),
  and Observability opens from a button on its own Settings page.

### Fixed

- `MenuButton`'s popover anchored against its wrapper `div`'s stretched
  width rather than the trigger's own box, pinning `align="right"` panels
  to the row's right edge instead of the button's whenever the trigger
  wasn't already sitting in a flex row that shrinks to fit — most visibly,
  Settings' `Add…` buttons.
- A failed routines-store refresh no longer blanks a page that still has
  data to show; stale inbox errors are retired and same-routine rows
  disambiguated; mark-reviewed failures now surface instead of failing
  silently.
- A pending focus-inbox request is cleared if its target window is
  destroyed before it's consumed.

## v2.0.10 — 2026-08-08

135 commits since v2.0.9, 151 files changed (+16,669 / −452).

### Added

**Diagnostics: what a process is, and stopping it**

- Every raw OS process is now attributed to a labeled Argus object instead
  of guessed at: a tier-A registry records real identity (pinned on first
  sample by pid+start time) at each process's own spawn site — Argus
  windows, driver children (Claude/Codex/ACP/Copilot), pack apps, MCP
  connector probes, and `graphify` — with tier-B/C inference over Electron
  flags and command lines as the fallback for anything unregistered, and
  reconciliation running on the sampling path so a registration and its
  first sample never race.
- Rows are flagged orphaned when the session or case that owns them is
  gone; the object section shows the owning case/session alongside the
  badge.
- A bucketed history ring retains a per-object CPU/memory series under an
  LRU cap, rendered as a sparkline on each row plus a full CPU/memory
  timeline chart with a window selector; a process that already exited
  still gets an ended-object row instead of vanishing from the history it
  left behind.
- Diagnostics rows can now be stopped from the page: termination routes
  through the owning driver or pack app's own stop mechanism when one is
  registered, escalating to a direct signal (leaves-first, identity-checked
  by pid+start time so a recycled pid is never touched) when there isn't
  one. An owner-routed stop also sweeps any stray subtree survivors it left
  behind, and the UI guards a stuck pending Stop with an escape-hatch
  timeout and ignores a stale press once a later one is in flight.

**Routines: scheduled unattended agent runs**

- A routine is a saved, schedulable definition — interval, daily, or
  weekly — that runs an agent turn in the background with no window and
  nobody present. Unattended sessions auto-deny risky permission asks and
  auto-dismiss questions rather than blocking forever, and the
  `bypassPermissions`/`acceptEdits` permission modes are force-downgraded
  so neither can silently skip that deny path.
- A wall-clock scheduler derives each routine's next fire time from its own
  run history (not a fixed anchor), runs at boot and stops at quit, catches
  up on a missed fire as an ordinary consequence of that arithmetic rather
  than a separate code path, and is verified across both DST transitions.
- A routine already running is queued rather than refused, re-resolving the
  live definition at drain time so editing or disabling a queued routine
  while it waits actually takes effect; run timeouts are capped at 120
  minutes. Runs are recorded with what triggered them and whether they
  succeeded, and reconciled on boot so one stranded by a crash or quit
  doesn't sit "running" forever.
- Settings gains a Routines page to define routines, run one now, and see
  next-run/queued state and each run's trigger.

**Suspect-commits skill**

- A new core skill for regression localization — finding which commit(s)
  introduced a bug — hooked into the systematic-triage workflow. It uses
  `git log -S`/pickaxe so a removal (not just an addition) can be caught as
  the suspect change, and avoids `git tag` since it sits outside the
  skill's read-allowlist.

**Composer and chat polish**

- The run-option menu's Reasoning level is now a real slider, and Context
  Window/Fast Mode/Thinking/Tool Results are segmented toggles; Ultrathink
  is drawn and behaves as the toggle it always was instead of inert text.
- The chat session status pill now shows a context-window usage gauge read
  off each assistant turn's own usage, so it reflects how close the next
  message is to triggering a compaction (currently populated only by the
  Claude driver).

### Fixed

- A session pinned to the bare `claude-opus-5` slug showed "Claude Opus 5
  (1M)" while actually running at the 200k window — context window is now
  represented only by the run option, not doubled up in the model's
  display name.
- The Claude/Copilot auth probe was timing out against a healthy,
  logged-in CLI: it ran from `os.tmpdir()`, and the CLI's boot-time
  directory walk took 6–17s against a large Windows temp root. Probes and
  headless one-shots now run from an app-owned empty scratch directory.
- Chat: a send refused by main (most notably the new routines guard) used
  to vanish the typed draft with no explanation; it now surfaces inline
  above the composer and re-stages the text.
- Default repositories collapses into a disclosure row instead of an
  always-open list; the Packs Sources page now checks for updates as soon
  as it's opened instead of only on request; popovers get their own
  frosted material instead of rendering as a flat rectangle.
- Diagnostics: a pack app opened within a few seconds of boot no longer
  gets stuck under the synthetic "Unattributed" row forever (tier-A
  registrations now age against the sidecar's own sample clock, not
  wall-clock arrival time); a wedged-but-handshaken sidecar no longer
  tells the user a live process "is no longer running."
- macOS: full screen dropped the traffic-light inset reservation.

### Internal

- Windows: the packs integration test that spawns a real copied
  executable now retries its teardown delete on `EBUSY`/`EPERM` instead of
  failing outright, closing a flake seen on a starved CI runner.

## v2.0.9 — 2026-08-07

5 commits since v2.0.8, 13 files changed (+287 / −15).

### Added

- Dev tools are now reachable without setting `ARGUS_DEV_TOOLS=1` before
  launch: tapping the version number in Settings → General 6 times persists
  an unlock marker that takes effect on the next launch, the same
  restart-required contract the env var already had.
- New case: both Jira key fields now accept a pasted full Jira issue link,
  not just a bare key, parsed down to the key before use.

### Fixed

- New-case Jira key handling: the restored key shown after a failed fetch
  is now correctly described as the parsed key rather than the raw pasted
  text, matching the error message shown alongside it.

## v2.0.8 — 2026-08-06

23 commits since v2.0.7, 38 files changed (+1,845 / −117).

### Added

**References are finally visible to the agent**

- Every session now receives a prompt-visible reference index — built fresh
  from the references directory (not read off `INDEX.md`, so a missed
  writer can't poison it), one line per reference with a capped 160-char
  summary and a 60-entry cap with an "…and N more" tail, telling the agent
  where to `Read` a file to register real usage.
- `INDEX.md` itself now regenerates on every reference mutation and heals a
  stale copy at boot, off a single recursive walk shared by statuses, the
  index, search, and usage — closing the gap where references existed but
  were never actually surfaced to any agent.

**Import skills from Claude**

- The Library's New menu gains "Import from Claude," which scans your local
  Claude skill directories and copies selected ones into `skills-user`
  through a picker dialog (conflict detection included).
- Imported skills are stamped with an `import` origin the same way a fork
  gets a `fork` origin, so a re-imported Argus-authored skill doesn't keep
  stale authorship metadata.
- The IPC-supplied source directory is validated to actually look like a
  Claude skills path (`<root>/.claude/skills/<name>`) before anything reads
  from or copies out of it.

**Case close**

- Closing a case now checks whether its distillation is stale and offers an
  opt-out checkbox to run one as part of the close confirmation, gated to
  the actual open→closed transition.

### Fixed

- Reference walk: a nested `INDEX.md` is now excluded by basename rather
  than path, so a pack shipping its own sub-router doesn't get its
  generated file offered as an editable asset; unguarded `readdirSync`
  calls in the walk that could abort session creation on a permission error
  are now guarded to degrade to "no references" instead.
- Prompts: the reference index is declared in the preview's omitted-blocks
  list so it doesn't silently inflate a size estimate meant to exclude it.
- Import dialog: the Cancel button and close paths are now gated on the
  dialog's actual busy state (scanning excluded) rather than blocking
  dismissal during the initial scan; a result-list index mismatch during
  confirm now falls back to a synthetic failure instead of misreading a
  neighboring result.

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
