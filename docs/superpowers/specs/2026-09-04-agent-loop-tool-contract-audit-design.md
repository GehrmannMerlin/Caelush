# Caelush Agent Loop and Tool Contract Audit Design

**Date:** 2026-09-04  
**Task branch:** `codex/v1-agent-loop-tool-contract-audit`  
**Baseline:** `df3f70f9d28099271b84fa635757e982bc444c89`  

## Goal

Audit and repair the production Agent Loop and native Tool Calling path with evidence from the final OpenAI-compatible HTTP request, a real Dispatcher round trip, two workspace environments, and a real DeepSeek user simulation. The round must establish whether tools are visible, whether provider tool calls are parsed and executed, whether results return to the next provider turn, why observed tool failures happen, and whether the Web presentation accurately describes deterministic decision summaries.

This round ends at Agent Loop `FINAL_CANDIDATE` and does not implement Verification repair, MCP, RAG, Skill, Sub-Agent/Multi-Agent, sandbox, retry, timeout, cancellation, or a new execution state machine.

## Existing architecture to preserve

- `@caelush/protocol` remains the source of truth for JSON-safe `ToolDefinition`, messages, events, and error contracts.
- `ToolRegistry` remains the single source of truth for the model-visible catalog and executable handlers.
- `AgentLoop` remains provider- and concrete-tool-independent.
- `RunController` remains the Core lifecycle authority and hands Tool calls to `ToolBatchCoordinator`.
- `ToolDispatcher` remains the only Tool execution boundary.
- `LLMGateway` and the OpenAI-compatible provider adapter continue to own one provider turn each; providers do not execute local tools.
- Runtime path containment, verified patch semantics, process ownership, and existing Tool lifecycle durability remain unchanged except for explicitly characterized error-code/guidance corrections.
- Durable events remain persisted before publication and the Web/CLI continue to consume the event stream rather than infer Core state.

## Evidence-first audit

The audit begins with a characterization suite before production behavior changes. A custom `fetch` supplied to the OpenAI-compatible provider captures only the outgoing JSON request body. It must not capture or persist Authorization headers. The normalized trace contains provider/model identity, message role sequence, message count, tool count/names, schema hashes, tool choice, timing, finish reason, decision type, and tool-call names/count. It never contains API keys, raw prompts, complete user content, raw Tool arguments, raw Tool output, hidden reasoning, or provider credentials.

The first request must demonstrate the actual adapter wire contract: `model`, messages/instructions, tools, and `tool_choice`. The normalized model-facing catalog must prove every active tool has a unique name, non-empty description, object-root input schema, top-level `additionalProperties: false`, valid property types, valid required fields, and bounded constraints. The test must assert the final provider request rather than only an internal `LLMRequest`.

The round-trip fixture emits a provider Tool Call on turn one and a final candidate on turn two. It captures the provider call ID, parsed model decision, Dispatcher invocation, model-facing Tool result, and second outgoing request. The second request must contain the assistant Tool Call and the matching Tool Result with exactly the same `toolCallId`. A separate Tool-error fixture proves an error result is re-injected as an observation and is not silently discarded.

## Model-facing Tool contract

`ToolDefinition` continues to contain only data needed by the provider contract. Execution handlers, effect/security projectors, Runtime objects, credentials, and runtime metadata do not enter provider tool definitions.

`ToolRegistration` gains a provider-independent optional `modelGuidance` value with this public type:

```ts
type ToolModelGuidance = {
  readonly summary: string;
  readonly guidelines: readonly string[];
};
```

The property and type names above are normative and remain separate from JSON Schema. Guidance is assembled from the same active registry snapshot as model definitions, so inactive tools cannot contribute prompt instructions. Built-ins document what they do, when to use them, when not to use them, parameter/path semantics, pagination/bounds, and important recoverable errors. Guidance remains concise; argument structure remains in the schema.

The nine built-ins retain the existing order unless environment-aware exposure removes Git tools:

```text
read_file
list_directory
find_files
search_text
apply_patch
exec_command
write_stdin
git_status
git_diff
```

## Core Agent Policy

The daemon's default base prompt becomes a short stable policy that tells the model it is operating inside a workspace, must gather evidence before making workspace claims, must use workspace-relative paths with `.` for the root, must treat Tool errors as observations, must correct recoverable input errors, must stop using inapplicable environment tools, must not mutate files for read-only inspection, must continue until the user's goal is sufficiently supported, and must return a final response only when evidence is sufficient or a real blocker is explicit. It does not request chain-of-thought or expose provider reasoning content.

## Workspace and Git behavior

Two bounded fixtures are used: a non-Git workspace and the same shape with a Git repository initialized. The audit reads durable invocation/observation records and reports only safe argument classifications such as relative or absolute, never private absolute paths.

`list_directory` must use `.` as the workspace-root convention. If characterization proves omitted `path` is the cause and the change is compatible with existing containment contracts, `path` becomes optional with default `.` across schema, handler, guidance, and tests. If the observed cause is an absolute path or another invalid argument, the containment boundary remains strict and guidance explicitly rejects absolute paths.

Non-Git `git_status` must resolve to a clear `NOT_A_GIT_REPOSITORY` model-facing error when the Runtime can distinguish it. The model-visible catalog must be environment-aware: Git tools are active only when existing Project Intelligence, Runtime capability, or Git discovery facts identify a Git repository. No second recursive scanner or independent Tool Router discovery is introduced. An erroneous call in a non-Git environment still fails clearly and safely.

Tool failures are classified for model behavior as `RECOVERABLE_INPUT_ERROR`, `ENVIRONMENT_INAPPLICABLE`, `PERMISSION_BLOCK`, `TOOL_INFRASTRUCTURE_ERROR`, or `UNCERTAIN_SIDE_EFFECT`. Input errors can be corrected, environment-inapplicable Git calls should stop rather than repeat, security errors cannot be bypassed through a more dangerous Tool, and uncertain mutations are never retried automatically. The prompt gives evidence-oriented stopping guidance without imposing a fixed Tool count.

## Safe diagnostics and Web semantics

An opt-in `CAELUSH_DEBUG_MODEL_WIRE=1` diagnostic records only safe normalized wire facts and provider-call timing. Default behavior is off. Diagnostic code must be tested for omission of API keys, Authorization, raw prompt/content, raw args/output, and hidden reasoning.

The source of `summarizeAgentDecision()` and the `reasoning.summary` event is characterized. If it is deterministic program output, the Web label changes from `推理摘要` to `决策摘要` or `Agent 决策`; the compatibility event type may remain unchanged. `llm.started`, `llm.completed`, and duration remain distinct from the deterministic summary. Tool failure cards show bounded public error codes without raw arguments, absolute paths, secrets, or internal exception text.

## Real DeepSeek product simulation

The real-provider test reads these environment variables without printing values:

```text
CAELUSH_PROVIDER_ID
CAELUSH_PROVIDER_BASE_URL
CAELUSH_PROVIDER_API_KEY
CAELUSH_PROVIDER_ALLOWED_MODELS
CAELUSH_DEFAULT_PROVIDER
CAELUSH_DEFAULT_MODEL
```

Each variable is reported only as `PRESENT` or `MISSING`. Missing configuration produces `REAL_PROVIDER_TEST_BLOCKED`; the test must not guess credentials or replace the real provider with a fake while claiming production success.

The test uses the product entry (daemon/Web session, Run creation, start, and event stream) and the real DeepSeek provider. It runs the exact read-only user request against a short-lived non-Git fixture and, when credentials are available, the Git fixture. Each fixture is capped at 12 provider turns; exceeding the cap stops the run and records `REAL_AGENT_LOOP_NOT_CONVERGING`. The result separately records `AGENT_LOOP_FINAL_CANDIDATE` and `RUN_FINAL_STATUS`, so a later Verification/Repair blocker cannot be misreported as an Agent Loop failure.

## Test and delivery gates

The implementation adds focused tests for the final wire tools, round-trip history, error re-injection, root paths, absolute-path rejection, Git/non-Git behavior, exposure, guidance assembly, summary semantics, timing, and safe trace redaction. Each behavior change follows TDD: a focused test is written and observed failing before the smallest implementation is added.

The final report is `docs/superpowers/reports/2026-09-04-agent-loop-tool-contract-audit.md` and contains the requested executive verdict, wire contract, failed-tool analyses, schema matrix, prompt before/after, real DeepSeek trace, reasoning UI semantics, security results, tests, and separate Verification blocker status. The task ends only after `pnpm check`, working-tree/diff review, push of `codex/v1-agent-loop-tool-contract-audit`, and verification that local and remote task SHAs match. Master is not merged.
