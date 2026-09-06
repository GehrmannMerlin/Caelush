# Phase 13F: Tool Contract Reliability & Execution Semantics Hardening

## Scope

Harden the existing Agent Tool Calling path across `packages/llm`, `packages/core`,
`packages/tools`, and `apps/daemon` while preserving the existing Protocol,
Security Authority, Runtime Authority, durable invocation lifecycle, approval
semantics, uncertainty barrier, and Phase 8/10/11 boundaries.

The canonical built-in Tool names remain unchanged. In particular, `exec_command`
remains the shell Tool and `write_stdin` remains the managed-process continuation
Tool. This round does not add MCP, RAG, Skills, Phase 14 work, or model-visible
`timeout_ms`, `background`, or `shell` arguments. Run deadlines, fixed platform
shell resolution, and managed process/session behavior remain owned by Core and
Runtime respectively.

## Current baseline

- The active default catalog contains `read_file`, `list_directory`, `find_files`,
  `search_text`, `apply_patch`, `exec_command`, `write_stdin`, `git_status`, and
  `git_diff`.
- `ToolRegistryBuilder` creates one immutable registry from each
  `ToolDefinition`, `ToolModelGuidance`, Handler, and optional security/effect
  projectors.
- `modelDefinitions()`, `modelGuidance()`, `names()`, and `resolve()` are derived
  from the same active registry.
- Input schemas are strict object-root schemas with
  `additionalProperties: false`; the compiled validator does not coerce,
  default, remove fields, or mutate caller input.
- The OpenAI-compatible path already handles fragmented/interleaved tool-call
  identity, but a provider argument containing only a repairable trailing comma
  currently fails before it reaches the Tool Dispatcher.
- Dispatcher argument failures already create model-recoverable durable
  observations, while ResourceGovernor provides run-level no-progress/replan
  protection. Phase 13F adds narrow argument normalization and bounded,
  in-memory ToolFailureMemory without creating a new storage model.

## Design decisions

### 1. Provider-side Tool Call Parser

Add an adapter-private parser under
`packages/llm/src/providers/openai-compatible/`.

The parser accepts the AI SDK's provider-facing `string | object` tool input and
returns a JSON object for the existing public `LLMToolCall` contract.

Allowed repair:

- Remove commas immediately before `}` or `]` while outside JSON strings.

Rejected without guessing:

- Unquoted object keys.
- Missing required fields.
- Truncated strings or incomplete structures.
- Unknown-field deletion.
- Command, patch, path, enum, boolean, or content rewriting.

The parser remains private to the OpenAI-compatible adapter, performs bounded
JSON-object validation, preserves ToolCall identity, and does not weaken the
provider-independent Gateway schemas.

### 2. Unified argument validation and normalization

Add `packages/tools/src/argument-validation.ts` with:

- `NormalizedArguments` as a cloned/deep-frozen JSON object.
- `ToolValidationError` carrying only bounded safe schema issues.
- `validateToolArguments()` that performs schema-directed normalization followed
  by the existing strict compiled validator.

The only value normalization permitted is conversion of a strict decimal string
to a schema-declared `integer` or `number` when the converted value is finite and
safe. No defaults are inserted, no unknown properties are removed, and no text
fields are changed. Schema `default` annotations are documentation only; the
runtime validator continues to use `useDefaults: false`.

The Dispatcher will normalize before durable invocation identity is persisted so
that equivalent model calls such as `yield_time_ms: "3000"` and
`yield_time_ms: 3000` share the same canonical invocation arguments. Invalid
arguments remain a durable `isError: true` observation and never reach a Handler.

### 3. ToolPreflight

Add a Tools-owned `ToolPreflight` abstraction for non-executing checks:

- active registry resolution;
- invocation argument byte bound;
- argument normalization;
- strict input schema validation;
- safe validation issue formatting;
- ToolFailureMemory lookup.

ToolPreflight will not make permission decisions or duplicate runtime
containment. Workspace realpath checks remain Runtime-owned. Dangerous-command,
sensitive-path, capability, logical containment, and approval decisions remain
Security-owned and continue through the existing injected Security Gate.

The effective order remains:

```text
Tool Call
  -> ToolPreflight
  -> durable REQUESTED
  -> Security Gate / Approval
  -> durable RUNNING
  -> Handler
  -> output validation / sanitization
  -> Observation
  -> Agent Loop continuation
```

### 4. Model-facing guidance

Extend the existing structured `ToolModelGuidance` with explicit safety and side
effect fields. Enrich all nine built-in descriptions with purpose, when-to-use,
when-not-to-use, parameter/default behavior, side effects, safety, and result
handling. The enriched descriptions remain data-only and are the descriptions
sent through the existing active registry to the provider.

The registry will not expose risk/capability/runtime metadata as provider Tool
fields. The existing `modelGuidance()` and `modelDefinitions()` ordering and
active Tool filtering must remain aligned with `resolve()`.

### 5. ToolFailureMemory

Add a bounded host-only `ToolFailureMemory` in `packages/tools`.

Each entry contains only:

- Run identity;
- Tool name;
- canonical arguments SHA-256 fingerprint;
- safe failure code;
- first/last timestamps;
- repeat count.

Raw arguments, command text, patches, secrets, prompts, and hidden reasoning are
never stored. Only model-recoverable argument/handler failures are recorded;
approval waits, Security denials, and uncertain side effects remain governed by
their existing authorities.

An identical failure in the same Run is durably represented as a new
model-recoverable observation that tells the Agent to change its arguments or
approach, without invoking the Handler again. The memory is bounded and
time-bounded. Existing durable ResourceGovernor behavior remains in place for
longer no-progress/replan decisions.

### 6. Safe Tool Calling debug

Add an optional daemon-wired debug port enabled only by
`CAELUSH_DEBUG_TOOL_CALLING=1`.

Debug records may contain Tool name, argument key/byte shape, normalization
status, safe validation issue paths/messages, preflight status, gate outcome
category, and execution status. They must not contain raw arguments, command
text, patch text, prompt text, provider responses, stdout/stderr, credentials,
secrets, or hidden reasoning.

The environment variable is interpreted by the daemon composition root; the
Tools package does not read process environment directly.

## Implementation order and TDD checkpoints

1. Add failing OpenAI-compatible parser characterization tests for a real
   OpenAI-shaped SSE path: trailing-comma repair, string safety, malformed-key
   rejection, and identity preservation.
2. Implement the adapter-private parser and run the focused LLM tests.
3. Add failing argument-validation tests for numeric-string normalization,
   safe integer/number bounds, missing required fields, unknown properties,
   command preservation, deep immutability, and sanitized errors.
4. Implement `ToolValidationError`, `validateToolArguments()`, and
   `ToolPreflight`; integrate them into Dispatcher budget preflight and dispatch
   identity handling.
5. Add failing Dispatcher/Batch/Core tests proving invalid arguments become
   durable model-recoverable observations, reach the next Agent turn, and do
   not execute handlers.
6. Add failing failure-memory tests for identical failure blocking, changed
   arguments, changed failure code, TTL/capacity bounds, and no raw-input
   retention.
7. Integrate `ToolFailureMemory` at the Dispatcher execution boundary without
   changing Security Gate or Runtime interfaces.
8. Add failing catalog/guidance tests and update all nine built-in descriptions,
   defaults, constraints, side effects, safety guidance, and recovery hints.
9. Add failing daemon debug tests and wire the safe debug writer.
10. Run focused tests after every implementation slice, then the package test
    suites, TypeScript checks, lint, and the full `pnpm check` command.
11. Build the workspace and run the real DeepSeek script with temporary
    credentials for at least the three approved scenarios: workspace structure,
    dependency analysis, and test execution, plus the dangerous-operation
    approval check. Capture only safe summary data.
12. Generate the Phase 13F Completion Report with inventory, scorecard, Bash
    before/after analysis, real-provider results, authority-boundary evidence,
    verification commands, and known limitations.

## Verification requirements

Before claiming completion:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm format:check`
- `pnpm check`
- `git status --short`
- `git diff --check`

The final report must clearly distinguish local mocked/injected-provider tests
from credentials-backed DeepSeek execution. A missing credential or unavailable
network is reported as a limitation and never represented as a successful real
provider run.

## Execution status

- [x] Repository and Tool registry audit completed.
- [x] Adapter-private Tool Call parser implemented and characterized.
- [x] Unified argument validation, safe numeric normalization, and ToolPreflight implemented.
- [x] Model guidance, schema metadata, and daemon Tool selection policy hardened.
- [x] Bounded ToolFailureMemory and safe Tool-calling debug implemented.
- [x] Focused tests, full tests, lint, typecheck, build, and changed-file format checks passed.
- [x] DeepSeek runner executed and safely recorded `SKIPPED` because provider credentials are absent.
- [x] Completion Report generated.
- [ ] Full `pnpm check` green: blocked by the pre-existing global format baseline (820 files).
