# SDK API surface notes

Verified against `@anthropic-ai/claude-agent-sdk@0.3.205`, file
`app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (the package's
`main`/`types` entry — `package.json` maps `"."` to `sdk.d.ts` / `sdk.mjs`).

Every name in the brief's Step 3 list is exported from the package root and
matches in spirit. The differences below are real and load-bearing for later
tasks; everything not listed here is a verbatim match.

## `PermissionResult` — `updatedInput` is optional, not required

Brief: `{ behavior: 'allow'; updatedInput: Record<string, unknown> }`

Actual:

```ts
type PermissionResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
      toolUseID?: string
      decisionClassification?: PermissionDecisionClassification
    }
  | {
      behavior: 'deny'
      message: string
      interrupt?: boolean
      toolUseID?: string
      decisionClassification?: PermissionDecisionClassification
    }
```

`updatedInput` is `?:` (optional) on the `allow` branch, plus extra optional
fields on both branches (`updatedPermissions`, `toolUseID`,
`decisionClassification`, and `interrupt` on `deny`). Code that always
returns `updatedInput` (e.g. echoing back the original `input`) still
satisfies this type — no source change needed — but don't assume the field
is present when reading a `PermissionResult` produced elsewhere.

## `CanUseTool` — third parameter has more fields than `{ signal }`

Brief: `opts: { signal: AbortSignal }`

Actual third parameter (still just needs `signal` for our use, but note the
full shape and that the parameter name in the .d.ts is `options`, not `opts`):

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal
    suggestions?: PermissionUpdate[]
    blockedPath?: string
    decisionReason?: string
    title?: string
    // + a few more optional UI-hint fields
  }
) => Promise<PermissionResult>
```

Parameter name (`options` vs `opts`) is cosmetic — callers name it whatever
they like. Only `signal` is required; the extra fields are optional metadata
useful for approval-card copy (Task P1.T6) but not required to compile.

## `SDKUserMessage` — `message` is the SDK's `MessageParam`, `session_id` is optional

Brief: `{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: string }] }, parent_tool_use_id: null, session_id: string }`

Actual:

```ts
type SDKUserMessage = {
  type: 'user'
  message: MessageParam // from '@anthropic-ai/sdk/resources'
  parent_tool_use_id: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  priority?: 'now' | 'next' | 'later'
  origin?: SDKMessageOrigin
  shouldQuery?: boolean
  timestamp?: string
  uuid?: UUID
  session_id?: string
  subagent_type?: string
  task_description?: string
}
```

Two real differences for the prompt-queue task (P1.T4):
- `message` is typed as the Anthropic SDK's `MessageParam`
  (`{ role: 'user' | 'assistant', content: string | ContentBlockParam[] }`),
  not an inline `{ role: 'user', content: [...] }` literal type. The literal
  object the brief describes (`role: 'user'`, `content: [{ type: 'text',
  text }]`) is a valid *value* of this wider type, so construction code is
  unaffected — just don't expect a named/exported type matching the brief's
  literal shape; use `MessageParam` (re-exported transitively, or define a
  local narrower type for construction).
- `session_id` is `?:` optional, unlike every other `SDKMessage` variant
  (`SDKAssistantMessage`, `SDKSystemMessage`, `SDKResultMessage`, etc.) where
  it is required. Outgoing user messages built for the prompt queue can omit
  it (the CLI assigns/threads the session), but code that reads
  `SDKUserMessage.session_id` back out of the stream must handle `undefined`.

## Everything else: confirmed as specified

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query`
  — brief showed `prompt: AsyncIterable<SDKUserMessage>`; actual also accepts
  a plain `string` (union), which is a superset, not a conflict.
- `Query extends AsyncGenerator<SDKMessage, void>` with `.interrupt(): Promise<...>`
  plus several other control methods (`setPermissionMode`, `close`, etc.) not
  mentioned in the brief — additive, no conflict. `AsyncGenerator` is a valid
  `AsyncIterable<SDKMessage>`.
- `Options` fields `cwd`, `additionalDirectories`, `includePartialMessages`,
  `systemPrompt: { type: 'preset', preset: 'claude_code', append?: string }`,
  `mcpServers`, `canUseTool`, `resume`, `pathToClaudeCodeExecutable`,
  `allowedTools`, `settingSources` — all present with the stated shapes
  (`append` is optional, matching "append: string" as an example usage).
- `SDKMessage` variants used by `normalize.ts`: `system`/`init`,
  `stream_event`, `assistant`, `user`, `result` — all present with the listed
  fields (see `SDKUserMessage` note above for the one wrinkle).
- `createSdkMcpServer({ name, version?, tools?: [...] })` and
  `tool(name, description, zodShape, handler, extras?)` — confirmed; `tool`
  has an additional optional 5th parameter not used by the brief.
