# Claude driver — captured SDK behaviour

Real `@anthropic-ai/claude-agent-sdk` output, recorded by running a live turn and
writing every raw message to JSONL. Claims here are observed, not read off `sdk.d.ts` —
this project has already been burned once by trusting that SDK's type declarations over
its runtime behaviour.

## `subagent-tool-calls.jsonl`

Captured 2026-07-19. One turn, `includePartialMessages: true` (matching production —
see `index.ts`), prompted to launch a Task sub-agent and have **the sub-agent** run two
tool calls. 45 messages.

### The question it answers

Sub-agent tool calls were reaching Langfuse with no name and zero duration
("Unnamed tool"). The suspicion was that their `tool.call.started` never fired.

### What the capture shows

Every `tool_use` in the run, by arrival path:

```
#10  stream_event/content_block_start  id=toolu_01WFaP  name="Agent"       parent=none
#19  assistant (finished message)      id=toolu_01WFaP  name="Agent"       parent=none
#27  assistant (finished message)      id=toolu_01LBx2  name="PowerShell"  parent=toolu_01WFaP
#30  assistant (finished message)      id=toolu_017XTF  name="Read"        parent=toolu_01WFaP
```

and the matching results:

```
#28  user  tool_result for toolu_01LBx2  parent=toolu_01WFaP
#31  user  tool_result for toolu_017XTF  parent=toolu_01WFaP
#34  user  tool_result for toolu_01WFaP  parent=none
```

Message-kind census for the run (note the count of streaming tool starts):

```
   1  stream_event/content_block_start:tool_use     <- only ONE, the top-level Task
   5  assistant
   4  user
   1  system/init
   1  result/success
   … (deltas, status, task_* events)
```

### Two load-bearing facts

1. **Sub-agent tool calls never appear as `stream_event` partials.** They arrive only as
   finished `assistant` messages carrying `parent_tool_use_id`. `normalize.ts` used to
   read only `text` blocks from `assistant` messages, so their starts were silently
   dropped — while their `tool_result` completions came through unconditionally. That
   mismatch is the whole bug: a completion with no start has no name to backfill and no
   start timestamp, hence "Unnamed tool" with zero duration.

2. **Top-level tool calls arrive TWICE** — once streaming (#10), once in the finished
   message (#19) — with the *same* `tool_use_id`. This is why `normalize.ts` gates
   sub-agent start emission on `parent_tool_use_id` rather than emitting for every
   `tool_use` block it sees: doing the latter would give top-level tools a second start
   whose later timestamp overwrites the real one, shortening their measured duration.

### The dependency this creates

Because top-level starts come *only* from the streaming path, they depend on
`includePartialMessages` staying on. Turning it off would strip names and durations from
every top-level tool with nothing pointing at the cause, so
`__tests__/claudeDriver.test.ts` carries a guard test asserting the option is set.

### Redactions

The capture is real SDK output with three edits, none touching the `tool_use` /
`tool_result` flow this fixture exists to document:

- `#2 system/hook_response` — `output`/`stdout` replaced. They carried the capturing
  environment's SessionStart hook text (an unrelated plugin's instructions), about a
  third of the original file.
- `#3 system/init` — `cwd`, `memory_paths`, and the `tools` / `mcp_servers` /
  `slash_commands` / `skills` / `plugins` / `agents` inventories replaced. `normalize.ts`
  reads only `model` from this message.
- Windows paths had the account name replaced with `<user>`, and the capturing session's
  scratch directory with `<tmp>`. Path *shape* is preserved deliberately — this is a
  fixture, and realistic paths are part of what it demonstrates.

Message count, ordering, ids, and every `parent_tool_use_id` are untouched, so the
numbering used above still refers to the lines in this file.

### Reproducing

No committed script — this was a throwaway. To recapture: call `query()` from the SDK
with `includePartialMessages: true`, a prompt that forces a Task sub-agent to run tools,
write each message to JSONL, and group by `parent_tool_use_id`.

## `init-auto-mode.json`

Captured 2026-08-11, against the exact SDK version this repo has installed
(`@anthropic-ai/claude-agent-sdk@0.3.220` — see `node_modules/@anthropic-ai/claude-agent-sdk/package.json`).
A single `system`/`init` message from a live `query({ options: { permissionMode: 'auto',
includePartialMessages: true }, canUseTool: … } })` run, prompted to run one `Bash` tool
call.

### The question it answers

Task 7's `onToolObserved` gate (`session.ts`) fires only when
`effectivePermissionMode` (read from this message's `permissionMode` field by
`normalize.ts`) is `'auto'` or a working `'bypassPermissions'` — the two modes where the
CLI structurally never calls `canUseTool`. Before this capture, no fixture in this repo
had ever seen a real `auto`-mode init message; every test that exercised the gate injected
the string `'auto'` by hand, which is vacuous proof that the CLI actually reports that
value at init.

### What the capture shows

The instrumented `canUseTool` callback in the capture script was invoked **zero** times
across the whole run, while the `Bash` tool call it prompted for still executed (an
`assistant` message carrying a `tool_use` block for `Bash`, followed by its `tool_result`)
— confirming empirically, not just per `sdk.d.ts`, that `'auto'` mode bypasses the
`canUseTool` callback entirely. The `system`/`init` message itself carries
`"permissionMode": "auto"`, matching what `normalize.ts` reads.

### Redactions

Same policy as `subagent-tool-calls.jsonl` above: `cwd` and `memory_paths` replaced
(this run's cwd was a scratch capture directory under the operator's home, not case
data); the `tools` / `mcp_servers` / `slash_commands` / `skills` / `plugins` / `agents`
inventories replaced (this operator's local plugin/skill set, not part of what the
fixture demonstrates). `permissionMode`, `claude_code_version`, `capabilities`,
`fast_mode_state`/`fast_mode_disabled_reason`, `session_id`, and `uuid` are untouched —
real values from the capture.

### Reproducing

No committed script. To recapture: call `query()` from the SDK with
`options: { permissionMode: 'auto', includePartialMessages: true }`, a `canUseTool`
callback that counts its own invocations, and a prompt that forces one tool call; assert
the counter stays zero after the run completes.

## `models-2-1-263.json`

Captured 2026-09-07 from `@anthropic-ai/claude-agent-sdk@0.3.263` (bundled CLI 2.1.263),
the version the floor moved to for Fable 5.1. `query({ prompt: 'hi', options: { cwd, maxTurns: 0 } })`
then `await q.supportedModels()`, written verbatim — no redactions, the payload carries
nothing operator-specific.

### The question it answers

Whether the new model can be reached without an SDK bump. It cannot: on 0.3.220 a turn on
`claude-fable-5-1` returned `API Error: 400 Claude Code 2.1.220 does not support this
model; version 2.1.251 or newer is required` — the API gates the model on the CLI's
version header, so upgrading the global `claude` does nothing for Argus (the SDK spawns its
own bundled binary). On 0.3.263 the same bare slug completes (`modelUsage` keyed
`claude-fable-5-1`, `contextWindow: 1000000`, one 4-token reply costing $0.78 — Fable
probes are not cheap; do not loop them).

### What the capture shows

Same five aliases as 2.1.220 with one change: `fable` now resolves to `claude-fable-5-1`
(description "Fable 5.1 · Most capable for your hardest and longest-running tasks"). No
alias resolves to `claude-fable-5` any more, so that model reaches the picker only through
the static built-in row — the union in `mergeBuiltinRows` is what keeps it. Capability
flags for the new row are identical to the old `fable` row: all five effort levels,
adaptive thinking, no fast mode.

### A row shape seen once, not in this file

The first `supportedModels()` read on 2.1.263 (same options, seconds earlier) returned a
SIXTH row: `{ value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable" }`
— a key that is a full wire slug WITH the `[1m]` suffix, resolving to the BARE slug. It was
gone on the next read and its origin is unconfirmed (this operator's `~/.claude.json` holds
per-project `model` entries for `claude-fable-5`, so a "currently configured model" row is
the likely source). Two assumptions it breaks: that no `value` ever starts with `claude-`,
and that a suffix on `value` implies one on `resolvedModel`. `pinSlugFor` handles it
(bare pin when a static row exists) and `catalogModels.test.ts` pins that; the fixture
itself records the reproducible read.

### Reproducing

Session scratchpad script, not committed: import `query` from the installed SDK, call
`supportedModels()` from an EMPTY cwd (a shared temp root makes CLI boot take 6–17s), and
write the array. Requires an authenticated CLI — unauthenticated, the call returns a
defaults list that looks real.
