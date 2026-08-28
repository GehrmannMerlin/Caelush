# OpenAI-Compatible Compatibility Matrix

状态：Phase 4C-2 与 Phase 4 完成记录（2026-08-28）。

本文记录 Caelush 对 OpenAI Chat Completions-compatible streaming provider 的
兼容性边界。所有兼容性测试都走完整链路：

```text
LLMGateway → OpenAICompatibleLLMProvider → streamText()
           → @ai-sdk/openai-compatible → custom fetch → OpenAI-shaped SSE
```

测试没有 mock `ai`、替换 `streamText()`、执行本地 Tool 或启动真实 AgentLoop。
固定依赖版本为：`ai@7.0.83`、`@ai-sdk/openai-compatible@3.0.39`、
`@ai-sdk/provider-utils@5.0.32`。本轮没有升级依赖，也没有修改
`node_modules` 或使用 `pnpm patch`。

## Measured matrix

| Shape                                                      | Result                    | Contract decision                                                          |
| ---------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| One real OpenAI-shaped text SSE turn                       | `PASS_UPSTREAM`           | Preserve text and finish through the Gateway.                              |
| Fragmented function arguments                              | `PASS_UPSTREAM`           | Emit deltas; complete only after the SDK has a complete call.              |
| First argument fragment is a parsable JSON prefix          | `PASS_UPSTREAM`           | Do not complete until later fragments arrive.                              |
| Function name arrives after argument fragments             | `PASS_UPSTREAM`           | Buffer until the name is available.                                        |
| Non-zero starting index                                    | `PASS_UPSTREAM`           | Keep provider index private; preserve the returned call identity.          |
| Non-contiguous indexes                                     | `PASS_UPSTREAM`           | Keep independent calls isolated.                                           |
| Reused indexes with stable IDs                             | `PASS_UPSTREAM`           | Stable IDs keep calls independent.                                         |
| Missing index with a stable ID                             | `PASS_UPSTREAM`           | Stable ID is sufficient when the SDK can resolve it safely.                |
| Out-of-order indexes                                       | `PASS_UPSTREAM`           | Keep completed calls in event-arrival order; never sort by provider index. |
| Empty ID on a continuation                                 | `PASS_UPSTREAM`           | Accept the SDK-resolved continuation when ownership remains clear.         |
| Whitespace-only ID                                         | `FAIL_CLOSED_UNSUPPORTED` | Reject as invalid; never normalize it into an identity.                    |
| Missing first ID                                           | `FAIL_CLOSED_UNSUPPORTED` | Reject; Caelush never synthesizes a UUID or fallback ID.                   |
| Duplicate stable ID across distinct tools                  | `FAIL_CLOSED_UNSUPPORTED` | Reject rather than merge or overwrite calls.                               |
| Missing ID and missing index while multiple calls are open | `FAIL_CLOSED_UNSUPPORTED` | Reject rather than use a `latestToolCall` heuristic.                       |
| Parameterless arguments (`""` and `{}`)                    | `PASS_UPSTREAM`           | Normalize both safe forms to the Caelush empty object input.               |
| Interleaved parallel calls with different names            | `PASS_UPSTREAM`           | No argument/name cross-contamination.                                      |
| Interleaved parallel calls with the same name              | `PASS_UPSTREAM`           | IDs keep same-name calls independent.                                      |
| Single and parallel ToolCallId round-trip                  | `PASS_UPSTREAM`           | Returned IDs are reused as outgoing `tool_call_id` values.                 |
| Provider reasoning content                                 | `PASS_UPSTREAM`           | Drop reasoning text from public `LLMTurnResult.text`.                      |
| Usage and finish metadata                                  | `PASS_UPSTREAM`           | Preserve normalized usage and `TOOL_CALLS` finish reason.                  |
| Malformed payload containing a secret                      | `FAIL_CLOSED_UNSUPPORTED` | Return a sanitized `LLMInvalidResponseError`.                              |

The matrix is executable in
`packages/llm/test/openai-compatible-compatibility.test.ts` and currently has
23 passing tests. Existing adapter error tests additionally cover HTTP error
mapping, no retry, external abort, timeout, network failures, and credential
redaction.

The test fixture for the parsable-prefix case uses `{"a":1` followed by
`,"b":2}`. Concatenating `{"a":1}` with `,"b":2}` would already be invalid
JSON, so the fixture deliberately models a valid incremental prefix while
testing the same premature-completion boundary.

## Adapter-private workaround record

One local guard is required for a pinned SDK behavior that is unsafe for the
Caelush contract. `@ai-sdk/provider-utils` can fall back to its latest tracked
tool call when a delta has neither an ID nor an index. That behavior is
ambiguous when more than one call is open: it can associate arguments with the
wrong call without throwing.

The adapter therefore enables AI SDK raw chunks and keeps a private state in
`packages/llm/src/providers/openai-compatible/raw-chunk.ts`:

1. Inspect only the SDK-provided raw chunk structure; Caelush does not rewrite
   or reimplement the SSE parser.
2. Record non-empty provider IDs and integer indexes already observed.
3. Reject whitespace-only IDs.
4. Reject a delta with neither ID nor index once multiple independent IDs or
   indexes have been observed.
5. Convert the guard failure into a fixed, sanitized
   `LLMInvalidResponseError`.

The guard does not create identity, reorder calls, or alter `LLMGateway`.
Normal identity and argument assembly remain upstream-owned. The test matrix
proves that single-call continuations still pass, while the ambiguous
multi-call case fails closed. This workaround can be removed when the pinned
upstream path guarantees an explicit, deterministic identity for every such
delta and the focused regression test remains green.

## Identity and round-trip proof

Caelush exposes only the provider's validated `ToolCallId`. It never generates
a replacement ID for a missing provider ID. The compatibility tests perform a
second Gateway turn using assistant tool-call messages and manually supplied
tool-result messages. Captured HTTP request bodies prove that the same IDs,
including each parallel call's own ID, are sent back as `tool_call_id` values.
No Dispatcher, filesystem, shell, Runtime, or local tool implementation is
involved.

## Optional real-provider smoke

The developer-only script
`packages/llm/scripts/smoke-openai-compatible.ts` is not part of the public API
and is not run by `pnpm check`. It is opt-in only:

```text
CAELUSH_LLM_SMOKE=1
CAELUSH_OPENAI_COMPATIBLE_BASE_URL=...
CAELUSH_OPENAI_COMPATIBLE_API_KEY=...
CAELUSH_OPENAI_COMPATIBLE_MODEL=...
CAELUSH_LLM_SMOKE_TOOL=1       # optional tool-call smoke
```

Without those variables it reports `SKIPPED`. Plain text smoke accepts only a
trimmed `CAELUSH_OK`; tool smoke checks that a tool call is returned and never
executes it. The local verification run intentionally had no credentials and
reported `SKIPPED`.

## Boundary after Phase 4

Phase 4 now ends at a provider-neutral, single-turn LLM boundary with a
verified OpenAI-compatible adapter. Phase 5 remains a separate task. AgentLoop,
tool dispatch, Runtime/Sandbox, Approval resolution, Storage integration,
EventBus bridging, Daemon provider configuration, Ink CLI features, and React
Web features remain out of scope.
