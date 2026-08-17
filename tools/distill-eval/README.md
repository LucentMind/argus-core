# @argus/distill-eval

Replay + judge harness for the case-distill prompt. Dev tool; never ships in the app.

This is the guide for the whole feedback loop: how rejects get labeled in the app, how a
corpus gets exported, how to run the harness against a prompt change, and how to read the
result. The design is `argus-docs/superpowers/specs/2026-07-29-distill-feedback-loop-design.md`;
this file is the day-to-day operator's manual.

## Why this exists

Case-close distillation (`app/src/main/services/distill/`) turns a closed case into skill/
reference/memory proposals. Sometimes it gets it wrong in one of two opposite directions —
**overfit** (too tied to this one case to reuse) or **overgeneric** (too vague to act on) —
and sometimes it's just **wrong** or a **duplicate**. Tuning the prompt to fix one failure
mode without causing the other requires three things this harness provides:

1. a labeled corpus of runs that went wrong (and right, as controls),
2. a way to rerun a candidate prompt over exactly those same inputs, and
3. a way to judge whether the candidate is actually better — not regressed elsewhere.

## The loop, end to end

```
 Argus app                                   this repo (dev machine)
┌──────────────────────────┐                ┌─────────────────────────────┐
│ case closes → distill job│                │                              │
│ enqueued, prompt_hash +   │                │                              │
│ input_snapshot frozen     │                │                              │
│           ↓                │                │                              │
│ proposals staged           │                │                              │
│           ↓                │                │                              │
│ reviewer accepts/rejects   │                │                              │
│ (reject: pick a reason tag)│                │                              │
│           ↓                │                │                              │
│ Settings → Prompts (dev)   │  NDJSON file   │                              │
│ → "Export distill eval     │ ─────────────▶ │ tools/distill-eval/          │
│    bundle"                 │  (by hand,     │  npm run build                │
│                             │   private repo)│  node dist/cli.js --corpus…  │
│                             │                │           ↓                  │
│                             │                │  replay with candidate       │
│                             │                │  prompt → parse → judge      │
│                             │                │           ↓                  │
│                             │                │  report.md + details.jsonl   │
└──────────────────────────┘                └─────────────────────────────┘
```

Nothing is uploaded automatically. The export writes one file to a location you pick; you
commit it by hand to a private evals corpus repo when you're ready to work on the prompt.

## Step 1 — label rejects in the app

Every proposal reject (Settings → Proposals tab) opens a small reason popover: `overfit`,
`overgeneric`, `wrong`, `duplicate`, `other`, plus an optional one-line note, or plain
"Reject" with no reason. This is shown for **every** reject, not just distiller-produced
proposals — but only rejects on proposals stamped with a `job:` id (i.e. produced by a
distill job, not a mid-case contribute-back) end up in the replay corpus, because only those
have a deterministic input to replay against.

The tags are defined in `app/src/shared/proposals.ts` (`REJECT_REASON_TAGS`) — that's the
single source of truth for what labels exist; the harness's judge prompt
(`src/judge.ts`) has special-cased phrasing for `overfit`/`overgeneric` since they're
opposite failure directions, and generic phrasing for the rest.

There's no separate "flag this whole distillation as bad" action. If a job produced one bad
item among several good ones, reject just that item — labels live at the item level.

## Step 2 — export a corpus bundle

Settings → **Prompts** → **Distill eval export** section → "Export distill eval bundle". The
Prompts page only appears in the Settings nav when Dev Tools is enabled (`payload.devTools`,
gated in `app/src/renderer/src/components/settings/settingsPages.ts`'s `visiblePages`) — with
it off the page is unreachable even via a hand-typed deep link, not just hidden from the nav.
This calls `exportEvalBundle` (`app/src/main/services/distill/evalExport.ts`), which:

- takes the **latest non-cancelled job per case** (`MAX(id) ... GROUP BY case_slug`) — an
  earlier job's proposals may have been superseded (deleted, un-archived) by a re-distill,
  so only the latest job's outcome set is structurally complete;
- includes it only if that job is `done` with **every** staged item reviewed (none still
  pending — skipped jobs are counted and named in the export result, e.g. "3 skipped: job 7
  (acme-timeout) — items pending review"), or `failed` with a stored `raw_output` (a parse
  failure is itself an eval case — a good candidate prompt should produce fewer of these);
- writes one NDJSON line per included job to the file you choose in the save dialog. Each
  line is a `DistillEvalBundleLine` (`app/src/shared/distillEval.ts`): the job's frozen
  `inputSnapshot`, its `promptHash`, its `rawOutput`, and every proposal outcome joined in
  from the archive (`accepted` / `rejected` + `rejectReason` + `rejectNote`).

**The file contains raw case data** — findings, evidence descriptions, chat titles, full
skill/reference bodies. Nothing is redacted; replay requires the real input. Treat it like
you'd treat the case itself: private evals repo or local checkout only, never a public repo,
never pasted into a ticket.

## Step 3 — run the harness

```bash
cd tools/distill-eval
npm install
npm run build
node dist/cli.js --corpus <path-to-corpus.ndjson> --out <path-to-results-dir>
```

Flags (`src/cli.ts`):

| flag | required | meaning |
|---|---|---|
| `--corpus <file>` | yes | the NDJSON bundle from Step 2 |
| `--out <dir>` | yes | where `report.md` and `details.jsonl` get written |
| `--contract <file>` | no | replace the distill contract prompt with this file's contents when replaying (see below) |
| `--model <id>` | no | model id passed to `claude -p --model <id>` |
| `--limit <n>` | no | only replay the first n corpus lines (fast iteration on a subset) |

By default (`--contract` omitted) the harness replays with the **repo's current
working-tree prompt** — `CASE_DISTILL_CONTRACT` / `CASE_DISTILL_SECTIONS` in
`app/src/main/services/distill/contract.ts` — so the normal workflow is: edit the contract
in your working tree, run the harness, read the report, iterate. `--contract` exists for
comparing an alternate draft without committing it, e.g. A/B-ing two candidate rewrites.

**Runners**: there are two, passed around together as `EvalRunners` (`src/replay.ts`):

| runner | type | used for |
|---|---|---|
| `agent` (`src/agentRunner.ts`, `claudeAgentRunner`) | `(prompt, world) => Promise<string>` | the distill replay itself — agentic, tools over the frozen world |
| `oneShot` (`src/runner.ts`, `claudeRunner`) | `(prompt) => Promise<string>` | the judge — one prompt in, one verdict out, no tools |

`claudeRunner` shells out to `claude -p --output-format text` (adding `--model` if passed),
piping the prompt over stdin — not argv and not `execFile` (whose default `maxBuffer` silently
truncates at 1MB; these prompts carry full skill/reference bodies so that limit is a real risk,
not a theoretical one).

`claudeAgentRunner` drives the Claude Agent SDK's `query()` headless with an **in-process MCP
server** (`createReplayMcpServer`) serving `list_sessions` / `read_transcript` /
`search_transcript` out of the exported `inputSnapshot.world` through the *same*
`app/src/main/services/distill/worldTools.ts` functions the live run used — same snapshot in,
same tool answers out. Its SDK options deliberately mirror the app's `runClaudeHeadlessAgent`:
`maxTurns: DISTILL_MAX_ITERATIONS`, `tools: []` (no built-ins), `allowedTools:
DISTILL_ALLOWED_TOOLS` (auto-approve only the `mcp__argus__` surface) plus a `canUseTool`
deny-gate, and an empty scratch `cwd`. If you need a different backend, implement `AgentRunner`
/ `OneShotRunner` and wire it in where `cli.ts` builds the runner bag.

**Agent replay: the two things it does not reproduce**

1. **`run_tool_script` (PTC) is stubbed.** The tool stays *registered* — its description is
   hashed prompt surface, so removing it would change the prompt being evaluated — but every
   call answers `REPLAY_PTC_UNAVAILABLE`, telling the agent to sweep with the direct tools
   instead. Real script execution needs the Electron-side PTC service
   (`app/src/main/services/ptc/run.ts`), which the harness cannot host. A replay of a job that
   used scripts therefore *approximates* its trajectory; since the judge grades final items and
   never trajectories, that is an accepted approximation, not a silent one.
2. **Pre-v2 corpus lines have no world → degraded replay.** Lines exported before the agentic
   distiller carry no `inputSnapshot.world`. They still replay (their `promptHash` never matches
   a v2 hash, so they always re-run), with all four tools registered and every world tool
   answering the distinguished error `transcripts unavailable for this replay (pre-v2 corpus
   line)`. `ReplayResult.degradedReplay` is set, `report.md` names those cases (see Step 4), and
   their verdicts should be read as "candidate could not read transcripts, baseline could" —
   never averaged in as a like-for-like comparison. Re-export the corpus from a current Argus to
   get worlds.

**What happens per corpus line** (`src/run.ts` → `runEval`, sequential — a corpus is tens of
cases, not thousands, and this shells out to a real model with real rate limits, so no
parallelism):

1. **Skip-if-unchanged** (`src/replay.ts` → `replayCase`): if the candidate prompt's static-
   part hash (`caseDistillPromptHash`, same sha256-over-fixed-order-parts function the app
   uses to stamp `prompt_hash` at enqueue) equals the job's stored `promptHash`, the harness
   reuses the stored `rawOutput` instead of spending a model call — the prompt genuinely
   didn't change for this case, so there's nothing to compare.
2. Otherwise it rebuilds the prompt with `buildCaseDistillPrompt(inputSnapshot, resolve)`
   and runs it.
3. **Parse** with the real `parseCaseDistillOutput`. A parse failure on a job that used to be
   `done` is an automatic `parse-regressed`; a parse success on a job that used to be
   `failed` is an automatic `parse-improved`; otherwise `ok` (still failing stays
   `still-failing`).
4. If parsing succeeded, **judge** each labeled item (skipped when the case was reused —
   those are automatically `unchanged`, "prompt unchanged — baseline output reused"):
   `buildJudgePrompt` (`src/judge.ts`) asks the same model to compare old vs. new output for
   that one item and return `improved` / `unchanged` / `regressed` / `needs-human` with a
   one-sentence reason. Three phrasings, by item outcome:
   - **rejected** → failure-direction-aware (fix overfit without going overgeneric, and vice
     versa);
   - **accepted, unedited** → "is there still an equivalent item, comparable or better" —
     positive controls, so silently dropping a previously-good item is a regression too;
   - **accepted after a human edit** (`editedContent`, exported when the accepter changed the
     draft) → the gold standard shifts to *the human's text*: "does the NEW item move closer to
     the human's accepted version than the old draft did?". Grading these against the draft
     would penalize a candidate for producing exactly what the reviewer had to hand-write.

## Step 4 — read the report

`report.md` (written by `src/report.ts`) leads with the aggregate numbers — including a
**degraded-replay count and the case list** (pre-v2 lines replayed with no world; read their
verdicts with the caveat above, or re-export the corpus) — then a **"Needs
human review" list first** (every `needs-human` verdict, prompt-changed or not — since
these are exactly the calls the judge couldn't make confidently), then a per-reject-tag
improved/total breakdown so you can see e.g. "overfit: 6/9 improved, overgeneric: 1/4
improved" and know which failure direction your prompt edit actually helped. `details.jsonl`
has the full per-case, per-item verdict data (including reasons) if you need to go deeper
than the summary — join it back to the corpus by `jobId`.

Read `needs-human` entries yourself before trusting the aggregate counts; the judge is
explicitly instructed to prefer `needs-human` over guessing, so a high needs-human count
usually means the corpus has ambiguous cases, not that the harness is broken.

## Iterating on the prompt

The normal cycle:

1. Pick a failure tag from a recent export's report (e.g. `overgeneric` is the majority of
   rejects).
2. Edit `CASE_DISTILL_CONTRACT` or the relevant `CASE_DISTILL_SECTIONS` entry in
   `app/src/main/services/distill/contract.ts`.
3. Re-run `node dist/cli.js --corpus <same file> --out <new dir>`.
4. Compare the new report's per-tag breakdown to the old one. Improvement on the tag you
   targeted with no new regressions on other tags (including the accepted-item positive
   controls) is the bar — a prompt change that fixes overgeneric outputs by making everything
   overfit again is not progress.
5. Land the contract change as a normal commit once you're satisfied; `prompt_hash` for new
   jobs will change automatically (it's derived from the contract text), so the next export
   naturally starts a new corpus generation.

Because replay reuses stored output whenever the hash matches, re-running the same corpus
after a no-op change (e.g. a comment-only edit to the contract that changes its hash without
changing meaning) still costs one full replay pass — hashing is over literal text, not
semantics.

## Known gaps (as of this writing)

- **No random spot-check sampling.** The original design called for a configurable random
  sample of verdicts alongside the `needs-human` ones, for a human to spot-check the judge
  itself; this was descoped in v1. In practice, read a handful of `improved`/`regressed`
  entries from `details.jsonl` yourself before trusting a big swing in the aggregate — the
  judge is a model call like any other and can be wrong in either direction.
- **Corpus loads fully into memory** (`src/corpus.ts`). Fine at current corpus sizes (tens to
  low hundreds of jobs); would need streaming if a corpus repo grows into the thousands.
- **No contribute-back tuning loop.** Reason labels are captured uniformly on every reject
  (see Step 1), but only job-stamped ones feed this harness. Mid-case contribute-back reject
  labels accumulate for a future project that judges proposal text directly without replay
  (no deterministic input exists for those) — nothing consumes them yet.
- **No PTC inside replays** and **no live coverage of the agent path.** The stub above is the
  first gap; the second is that the tests fake `query()`, so the real SDK call (bundled-CLI
  discovery from a plain node process, auth, extraction) is only ever exercised by actually
  running the harness against a corpus. If a replay produces nothing, check that `claude` works
  on your machine before suspecting the harness.
- **No wall-clock cap on a replay.** `maxTurns` bounds the loop, but neither runner has a
  timeout (the app's own distill path does); a wedged provider call hangs the run until you
  interrupt it.
- **No corpus-repo tooling.** Merging/deduping bundles across multiple developers' exports,
  or a retention policy for old lines, doesn't exist — start manual, revisit if the corpus
  repo grows enough to make hand-merging painful.

## Tests

**These tests do not run in CI** — the workflow only runs from `app/`. Run them locally
(`npm test`) whenever you touch this package; nothing else will catch a break.

`npm test` (vitest) covers the pure logic with fakes — **no live model calls, no CLI spawn**:
corpus parsing/validation (`__tests__/corpus.test.ts`), skip-if-unchanged + parse
classification + world/degraded replay (`__tests__/replay.test.ts`), judge prompt/verdict
round-tripping including a byte-identity inline snapshot of the unedited-accepted wording
(`__tests__/judge.test.ts`), the agent runner's SDK option assembly and the replay MCP server's
answers with and without a world (`__tests__/agentRunner.test.ts`), and the full `runEval`
pipeline wiring (`__tests__/run.test.ts`).

The agent runner takes its `query()` as an injected `CreateQueryFn` (defaulting to the SDK's
`query`), which is the seam the tests fake: they assert the assembled
`mcpServers`/`allowedTools`/`maxTurns`/`tools: []`/`canUseTool` wiring and drive a scripted
message stream, so the SDK's bundled CLI is never spawned. The MCP-server tests connect a real
`@modelcontextprotocol/sdk` client over `InMemoryTransport` (same idiom as the app's
`distill/__tests__/mcp.test.ts`) and call the tools for real against a fixture world.

`npm run typecheck` type-checks this package on its own `tsconfig.json` (it imports app source
directly, relative-pathed — see the `../../../app/src` imports in `src/replay.ts`,
`src/agentRunner.ts` and `src/corpus.ts` — rather than depending on a built package).

`npm run build` keeps `@anthropic-ai/claude-agent-sdk` **external** on purpose: it is ESM that
calls `createRequire(import.meta.url)` at module scope and finds its own bundled CLI relative to
its own file, so inlining it into the CJS bundle makes `dist/cli.js` throw on load. Leave that
`external` entry in `build.mjs` alone.
