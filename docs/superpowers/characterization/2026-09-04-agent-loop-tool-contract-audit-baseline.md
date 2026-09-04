# Agent Loop and Tool Contract Audit — Baseline Characterization

Date: 2026-09-04 (Asia/Shanghai)

This is an evidence baseline only. No production behavior was changed by Task 1. Conclusions are labeled `CONFIRMED`, `PARTIALLY CONFIRMED`, or `REJECTED`. A suspected failure cause is not asserted unless reproduced by a fixture.

## 1. Starting state

The required baseline commands were run in the existing Windows checkout, without changing the working tree:

```text
PS D:\Develop\Caelush> git status --short
(no output; clean at capture time)

PS D:\Develop\Caelush> git branch --show-current
codex/v1-agent-loop-tool-contract-audit

PS D:\Develop\Caelush> git rev-parse HEAD
5d7ff691ba112a4fb9540bf9bdb9baf43cfc6a5b

PS D:\Develop\Caelush> git merge-base --is-ancestor df3f70f9d28099271b84fa635757e982bc444c89 HEAD
(exit code 0)
```

**CONFIRMED:** the checkout is on the task branch, the required baseline commit is an ancestor, and there were no pre-existing user changes to preserve at capture time.

## 2. Current built-in catalog

The active catalog is assembled by `composeDaemon()` through `createDefaultBuiltinToolRegistrations(runtimeResolver)`, then registered once in `ToolRegistryBuilder` and exposed through `ToolBatchCoordinator`. `DEFAULT_BUILTIN_TOOL_ORDER` defines the current nine-tool order:

| Order | Tool | Current role (from source definition/registration) |
| ---: | --- | --- |
| 1 | `read_file` | bounded workspace-relative UTF-8 file read |
| 2 | `list_directory` | bounded workspace-relative directory listing |
| 3 | `find_files` | deterministic bounded file discovery |
| 4 | `search_text` | bounded text search using the runtime search backend |
| 5 | `apply_patch` | verified bounded Add/Update/Delete/Move patch mutation |
| 6 | `exec_command` | fixed-platform argv command execution through the runtime |
| 7 | `write_stdin` | interaction with an owned in-memory process session |
| 8 | `git_status` | read-only Git status inspection |
| 9 | `git_diff` | read-only Git diff inspection |

**CONFIRMED:** the model-visible definitions and executable resolution originate from one immutable `ToolRegistry`; `modelDefinitions()` returns the registry’s ordered definitions and the dispatcher resolves handlers from that same registry. The registry freezes the definition/catalog boundary and rejects duplicate registration during build (verified by the existing registry tests and source inspection).

**CONFIRMED:** the current daemon composition exposes all nine built-ins through the batch coordinator. The catalog does not include a separate model-only map in `RunExecutionConfig`; `RunController` obtains definitions from `toolCoordinator.modelDefinitions()` when constructing the loop input.

## 3. Production seam map

The following roles were recorded from the requested entry points.

| Entry point | Observed responsibility |
| --- | --- |
| `apps/daemon/src/daemon-composition.ts` | Composition root: creates context, provider gateway, local runtime, immutable built-in registry, secure dispatcher/coordinator, and `RunController`; owns wiring, not a second AgentLoop. |
| `packages/core/src/agent-loop.ts` | Provider-independent decision loop. Validates input/context, builds one LLM request, settles one Agent Step attempt, classifies the turn as tool calls or final candidate, and returns at a tool/verification boundary. It does not execute concrete tools. |
| `packages/core/src/agent-loop-request.ts` | Projects built context messages, caller-supplied data-only tool definitions, model, tool choice, and optional model settings into a validated `LLMRequest`; copies the tool array. |
| `packages/core/src/run-controller.ts` | Durable run orchestration and recovery. Supplies the coordinator catalog, persists tool continuations/results, drives the batch boundary, re-enters the loop, and routes final candidates into `VERIFYING` rather than directly to completion. |
| `packages/tools/src/registry.ts` | Immutable lookup from `ToolName` to definition, handler, compiled input/output validators, and optional effect/security projectors; also provides ordered model definitions. |
| `packages/tools/src/batch-coordinator.ts` | Validates a complete batch, dispatches sequentially in assistant source order, stops at approval/uncertainty boundaries, and returns model-facing ordered result items. |
| `packages/llm/src/gateway.ts` | Owns one provider turn and call identity/lifecycle, validates provider stream events, maps abort/timeout/consumer causes, and aggregates a validated `LLMTurnResult`; it never executes tools or retries. |
| `packages/llm/src/providers/openai-compatible/provider.ts` | Adapter around the AI SDK OpenAI-compatible provider. It normalizes provider configuration and delegates streaming to the adapter-private stream path while implementing the Caelush `LLMProvider` contract. |
| `packages/llm/src/providers/openai-compatible/tools.ts` | Data-only projection from Caelush `ToolDefinition` to AI SDK tool schemas and tool-choice values; no execute callback is installed. |
| `packages/llm/src/providers/openai-compatible/messages.ts` | Converts Caelush system/user/assistant/tool messages into AI SDK model messages, preserving assistant tool calls and reinjecting tool results as tool-result content. |
| `packages/core/src/agent-summary.ts` | Creates bounded public summaries: final-candidate verification notice, tool-call count with at most five displayed names, and max-step boundary text. It does not include model answer text, arguments, or hidden reasoning. |
| `apps/web/src/components/timeline.ts` | Renders already-reduced client timeline state, localizes the nine known tool labels, suppresses raw tool output, bounds public IDs, and renders only narrowly safe patch/command detail patterns. |

**CONFIRMED:** `rg` call-site inspection found the expected paths: `modelDefinitions()` is consumed by the daemon/controller/tool tests; `buildAgentLLMRequest()` is called by `AgentLoop`; `summarizeAgentDecision()` is used for settled step reasoning summaries; and `reasoning.summary` is produced by run-controller events and consumed by client/CLI/web timeline reducers/tests.

**PARTIALLY CONFIRMED:** source inspection characterizes current boundaries and data flow, but does not establish a failure cause for any future audit fixture. No fixture in this baseline reproduces an observed contract failure.

## 4. Current summary and reinjection semantics

**CONFIRMED:** an `AgentDecision` of `FINAL_CANDIDATE` produces the fixed public text “Produced a final candidate response; verification is required before completion.” A tool decision reports only the number of calls and up to five names, with a bounded `+ N more` suffix. Max-step exhaustion reports the configured maximum. These summaries are used as `reasoningSummary` on settled steps and as `reasoning.summary` payloads for the public event stream.

**CONFIRMED:** the LLM request path sends data-only definitions and validated model messages to the provider adapter. Assistant tool-call parts retain `toolCallId`, `toolName`, and JSON input; normalized tool results are converted to tool-result message parts with model-facing content and error state. Runtime IDs, structured details, raw arguments beyond the model message contract, and internal causes are not part of the tool-result projection.

**CONFIRMED:** `RunController` persists the open tool turn as a continuation, accepts a complete matching result batch, and only then resumes the AgentLoop for the next provider turn. A final candidate transitions the durable boundary to `VERIFYING`; it is not a direct `COMPLETED` decision.

## 5. External design evidence

The following are source references, not implementation instructions. Notes are limited to schema projection, active exposure, prompt guidance, parsing, result reinjection, and termination.

### OpenAI Codex

- [tool_executor.rs](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_executor.rs): **CONFIRMED (external pattern).** A tool executor couples the tool name and model-facing spec to the executable runtime, while explicit exposure surfaces distinguish direct, deferred/search, code-mode, and hidden registration. The source also exposes a capability-style `supports_parallel_tool_calls` hook, defaulting to false.
- [router.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/router.rs): **CONFIRMED (external pattern).** A finalized router retains the registry and a separately computed model-visible spec set, then routes calls by source/surface. It sanitizes plaintext argument logging and treats routing/exposure as a turn-level concern. This is evidence for an explicit exposure projection, not evidence that Caelush should copy the Rust structure.

### Pi

- [system-prompt.ts](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/system-prompt.ts): **CONFIRMED (external pattern).** Prompt construction receives selected active tools and optional one-line snippets, lists only tools with supplied snippets, and derives guidance from the tools actually enabled. Project context and skills are appended separately from the active tool list.
- [extensions.md](https://github.com/fivewillow/badlogic-pi-mono/blob/main/packages/coding-agent/docs/extensions.md): **CONFIRMED (external pattern).** Extensions register a name, description, parameter schema, and executable function; active tools can be queried and changed at runtime. The documented result has model-facing content plus structured details, and the extension boundary explicitly warns that code runs with full permissions. This supports separating model projection, execution, and user-facing detail.

### DeepSeek Harness

- [tools subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md): **CONFIRMED (external pattern).** The subsystem documents a pipeline with a frozen/lossless final result observation and separate dispatch/result hooks. It distinguishes settled content from runtime observation and contains explicit cancellation/error handling guidance.
- [core tools README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md): **CONFIRMED (external pattern).** A unified schema DSL projects to raw JSON Schema; presentation mode controls whether the model sees native definitions, a generated program tool, or both. Tool-call history reinjects final content/errors, while intermediate program results remain internal unless returned or printed. The README also documents deterministic active-set/schema effects and a non-enforcing declarative timeout field.

**PARTIALLY CONFIRMED:** these external projects independently support explicit tool exposure, schema projection, structured-vs-model-facing results, and clear termination boundaries. They do not, by themselves, prove a defect in Caelush or identify a fixture-specific failure cause.

## 6. Verification record

Commands and results:

```text
pnpm exec vitest run --config vitest.config.ts <four requested tests>
FAIL (startup): root vitest.config.ts does not exist; no test files executed.

pnpm test -- packages/llm/test/openai-compatible-compatibility.test.ts packages/core/test/agent-loop-integration.test.ts packages/storage/test/run-controller-tool-integration.test.ts packages/tools/test/default-tools.test.ts
PASS — Test Files 4 passed (4); Tests 38 passed (38); Duration 9.68s.

git diff --check
PASS (after this document was created).
```

**CONFIRMED:** the repository-supported invocation passes all four requested characterization suites (38/38 tests). The failed `--config vitest.config.ts` invocation was a command/setup mismatch, not a reproduced product failure.

## 7. Concerns and scope limits

1. **PARTIALLY CONFIRMED:** there is no root `vitest.config.ts`; future audit commands should use the package script (`pnpm test -- …`) or discover the applicable configuration rather than assuming a root config.
2. **PARTIALLY CONFIRMED:** this record is static source/test characterization. It intentionally does not add a failing fixture and therefore does not claim a root cause for any audit hypothesis.
3. **CONFIRMED:** Task 1 did not modify production code, alter the nine-tool catalog, add a new Phase, or implement exposure/permission/verification behavior.

## 8. Commit

Final reviewed Task 1 commit (the earlier `7629369b3fa690091582df2b0dfca07b2ddbc38c` was superseded by the provenance correction):

```text
e0825046f944f043cc59251b5f01807370289704
```
