# Caelush Phase 4C-2: OpenAI-Compatible Compatibility Hardening

## Status

Approved implementation design for Phase 4C-2 and Phase 4 finalization.

The Phase 4C-1 baseline is already committed as `c596938` (`feat(llm): add
OpenAI-compatible provider adapter`). This work continues from that baseline
without rewriting the existing history. The current implementation branch is
`codex/phase-4c2-openai-compatible-hardening-lf`.

## Goal

Characterize real OpenAI-compatible streaming tool-call behavior through the
complete Caelush path, add deterministic regression coverage for the observed
compatibility matrix, and introduce only narrowly proven adapter-private
normalization when the pinned AI SDK cannot safely handle a provider shape.
Finish Phase 4 with a documented, provider-independent Gateway and explicit
boundaries for unsupported ambiguous streams.

## Frozen Architecture

The Phase 4 architecture remains:

```text
Future AgentLoop
      |
      v
  LLMGateway
      |
      v
  LLMProviderRegistry
      |
      v
  LLMProvider
      |
      v
  OpenAI-compatible adapter
      |
      v
    AI SDK
      |
      v
  Provider HTTP API
```

`LLMGateway` remains responsible for call IDs, semantic request validation,
abort/timeout/cancellation, provider-independent stream validation, result
aggregation, and the no-retry boundary. The adapter remains responsible for
Caelush-to-AI-SDK conversion and AI-SDK-to-Caelush normalization. It never
executes tools, generates Caelush call IDs, owns timeout policy, or exposes AI
SDK types through the public package API.

## Compatibility Investigation

Every matrix case is tested through `LLMGateway`,
`OpenAICompatibleLLMProvider`, `streamText`, `@ai-sdk/openai-compatible`, and a
custom fetch that returns a real OpenAI Chat Completions-shaped SSE response.
Tests must not mock `ai` or replace `streamText`; the purpose is to observe the
actual upstream parser and provider normalization behavior.

The test-only fixture builder will produce valid SSE responses with:

- OpenAI Chat Completions chunk envelopes;
- fragmented `tool_calls[].function.arguments`;
- optional `index`, `id`, `type`, `function.name`, and arguments fields;
- finish chunks and usage-bearing chunks;
- malformed or ambiguous shapes used to prove fail-closed behavior.

Each case is classified as exactly one of:

- `PASS_UPSTREAM`: the pinned SDK correctly handles the shape; retain a
  regression test and add no production workaround;
- `PASS_ADAPTER`: the SDK output is safe but requires a deterministic
  adapter-local conversion; document the algorithm and round-trip proof;
- `FAIL_CLOSED_UNSUPPORTED`: the shape is ambiguous or cannot be repaired
  without guessing; return `LLMInvalidResponseError` without exposing raw SSE.

The initial implementation will not assume that the known upstream fixes are
complete. In particular, non-zero indexes, reused indexes, missing indexes,
late names, blank IDs, and whitespace IDs will be run against the installed
versions before any production change is considered.

## Tool Identity and Ordering

Tool-call identity is preserved from the normalized AI SDK output. No UUID or
other synthetic identity is generated for a missing provider ID. A workaround
is permitted only if identity is deterministic, independent parallel calls
cannot be cross-contaminated, and a later Caelush ToolResult can be converted
back to the same outgoing `tool_call_id`.

When an incoming shape supplies both a stable ID and a different tool identity
for another call, the adapter must fail closed rather than merge calls. A delta
with neither ID nor index is accepted only when upstream behavior proves that
its ownership is unambiguous; otherwise it fails closed, especially when more
than one call is open. No `latestToolCall` heuristic is allowed.

`LLMTurnResult.toolCalls` keeps completed-event arrival order from Phase 4B.
Raw provider indexes are never exposed in the Caelush stream contract and are
not used to reorder the final result.

## Round-Trip Coverage

The compatibility suite manually performs two provider turns. Turn 1 emits one
or more tool calls. The test then constructs assistant tool-call messages and
manual tool-result messages using the exact returned IDs, and sends Turn 2
through the Gateway. The captured HTTP request must contain the same
`tool_call_id` values, both for single and parallel calls. No filesystem,
shell, dispatcher, runtime, or other tool implementation is invoked.

## Optional Smoke Validation

`packages/llm/scripts/smoke-openai-compatible.ts` is a developer-only utility,
not part of the production API and not part of `pnpm check`. It reads explicit
environment variables only in the script:

```text
CAELUSH_LLM_SMOKE=1
CAELUSH_OPENAI_COMPATIBLE_BASE_URL
CAELUSH_OPENAI_COMPATIBLE_API_KEY
CAELUSH_OPENAI_COMPATIBLE_MODEL
CAELUSH_LLM_SMOKE_TOOL=1
```

Without credentials it reports `SKIPPED`. Plain-text smoke accepts a trimmed
`CAELUSH_OK`; optional tool smoke only verifies that a tool call is returned
and never executes the tool. Provider capability limitations may also produce a
reported `SKIPPED / unsupported` result.

## Non-Goals and Guards

This phase does not:

- modify `packages/llm/src/gateway.ts` for provider-specific behavior;
- add fields to `LLMStreamEvent` for raw provider metadata or indexes;
- rewrite the OpenAI SSE parser;
- patch `node_modules` or use `pnpm patch`;
- upgrade dependencies without a failing pinned regression and a verified
  stable-patch fix;
- add AgentLoop, ContextBuilder, ToolDispatcher execution, Runtime, Storage,
  EventBus, Daemon provider configuration, or host-product functionality;
- expose reasoning or raw chain-of-thought content in Caelush contracts.

## Documentation and Acceptance

Add `docs/architecture/openai-compatible-compatibility.md` with the measured
matrix, pinned dependency versions, classifications, unsupported shapes,
workaround records (if any), round-trip evidence, and smoke result. Update
`docs/architecture/llm-gateway.md` and `AGENTS.md` to record the completed
Phase 4 boundary and compatibility rules.

Completion requires the entire matrix, round-trip tests, no-retry/abort/
timeout/secret/SDK-isolation audits, full build and test verification, removal
of generated artifacts followed by frozen install and `pnpm check`, and a
clean Git worktree. Phase 5 is explicitly out of scope.
