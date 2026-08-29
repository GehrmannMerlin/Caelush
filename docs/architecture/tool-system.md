# Caelush Tool System

Caelush Phase 7 is fixed to exactly three rounds:

- Phase 7A — Tool Contracts, Registry & Schema Runtime
- Phase 7B — Tool Dispatcher & Durable Invocation Lifecycle
- Phase 7C — Tool Batch Coordination & Agent Runtime Integration

There are no additional Phase 7 rounds.

## Architecture

```text
Model
  │
  ▼
ToolDefinition[]
  │
  ▼
AgentLoop
  │
  ▼
AgentToolRequest
  │
  ▼
Future ToolDispatcher
  │
  ▼
ToolRegistry.resolve()
  │
 ┌┴──────────────┐
 ▼               ▼
Definition     Handler
 │               │
Schema           │
Validator        │
 └──────┬────────┘
        ▼
 Future execution
```

`@caelush/protocol` owns the JSON-safe `ToolDefinition`, `ToolName`, `ToolInvocation`, `RiskLevel`, and `Capability` contracts. `@caelush/tools` owns the registration, schema runtime, output policy, and immutable registry. A `ToolRegistration` binds one definition to one handler; the handler has no independent tool name. The registry is the single source of truth for both model-visible definitions and future runtime resolution.

## Three Separate Layers

Prompt Guidance, Tool Definition, and Tool Runtime are related but different:

1. Prompt Guidance explains when to use tools, how tools should be selected, cross-tool preferences, and security behavior. It belongs to the Agent/System prompt layer, not the registry.
2. Tool Definition describes the model-facing name, concise purpose/boundary description, and input JSON Schema. Argument-specific guidance belongs in schema property descriptions.
3. Tool Runtime owns the handler and execution result. Phase 7A defines these contracts and precompiled validators but does not execute handlers.

This separation follows the design observed in the open-source Codex tool system. Codex keeps global tool instructions, model tool specifications, and executable tool runtimes distinct. Caelush adopts the boundary without copying Codex's host-specific tool list or execution machinery.

## Registry Invariant

Anything advertised to the model must resolve in the same `ToolRegistry` snapshot. `ToolRegistryBuilder` validates and copies registrations, compiles input and output schemas once, checks count and byte budgets, and creates an immutable ordered registry. `modelDefinitions()` and `resolve()` therefore cannot drift into separate model/runtime maps. Duplicate names are configuration errors and never shadow an existing registration.

The registry does not compose system prompts, developer prompts, AGENTS instructions, or cross-tool routing policy. This prevents a prompt from advertising a tool that is absent from the active catalog, the lesson highlighted by Codex issue #30648.

## Schema Runtime Policy

The schema runtime uses Ajv `8.20.0` with `allErrors: true`, `strict: true`, `coerceTypes: false`, `useDefaults: false`, and `removeAdditional: false`. Schemas compile at registry build time, not per invocation. Validation returns Caelush-owned issues containing only `instancePath`, `keyword`, and `message`, capped at 16 issues; raw schema and input data never enter the result.

Phase 7A tool schemas must have object roots and `additionalProperties: false` at the top level. Local references such as `#/$defs/value` are supported when Ajv can compile them deterministically. External references, async schemas, custom keywords, and external schema loading are rejected. Schema objects are canonicalized only for deterministic UTF-8 byte accounting: object keys are sorted, while array order and schema semantics are preserved. There is no lossy schema compaction; over-budget schemas fail closed.

## Model and Runtime Data

The model-facing projection contains only:

- `name`
- `description`
- `inputSchema`

`riskLevel`, `requiredCapabilities`, `runtimeRequirements`, and `outputSchema` are runtime metadata. They are not provider tool fields. `outputSchema` validates `ToolExecutionResult.details`, not `ToolExecutionResult.content`.

`ToolExecutionResult.content` is model-facing text. `details` is structured runtime/UI data, and `isError` is the shared error state. `ToolOutputPolicy` provides a common UTF-8-safe model content bound with an explicit `[output truncated]` marker; details are not truncated by this policy.

## Security and Phase Boundaries

`riskLevel`, `requiredCapabilities`, and `runtimeRequirements` are metadata, not authorization. Permission, capability and risk evaluation, and approval enforcement belong to Phase 9. Filesystem, Shell, Process, and Git handlers belong to Phase 8.

Phase 7A does not execute a handler, create a `ToolInvocation` or `ToolObservation`, persist invocation/output data, publish tool lifecycle events, evaluate permissions, request approvals, load tools dynamically, use MCP, use Tool Search, or use Code Mode. The user-visible durable `tool.requested` event contract contains only `invocationId`, `toolName`, optional `externalCallId`, and `riskLevel`; it never requires raw tool arguments. Full invocation data remains a future private persistence concern.

Ordinary tool failure will become a model-visible tool result in Phase 7B rather than an automatic Run failure. Phase 7B is also the first phase that may connect registry resolution to validation gates, invocation persistence, handler execution, output validation, observations, and tool events.
