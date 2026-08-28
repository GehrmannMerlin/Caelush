# ContextBuilder

Phase 5C completes the in-memory boundary between discovered project facts and a future model turn. The builder does not call an LLM, choose a model, execute tools, read the filesystem, publish events, or persist a snapshot.

## Data flow

```text
Project Intelligence
        +
Relevant File Plan
        +
Conversation
        +
User Message
        +
Base System
        +
Input Limit
        │
        ▼
   ContextBuilder
        │
        ▼
BuiltModelContext
        │
        ▼
    LLMMessage[]
```

`ProjectInspector` produces a `ProjectIntelligenceSnapshot`, and `RelevantFilePlanner` produces a task-specific `RelevantFileContextPlan`. `ContextBuilder` consumes those already-materialized values; it never re-scans, re-scores, or re-reads files.

## Public contract

`ContextBuildInput` contains `baseSystemPrompt`, the snapshot, optional relevant files, optional history, the required `currentUserMessage`, and caller-supplied `limits`. `BuiltModelContext` contains only `messages` and a metadata-only `ContextBuildReport`; it does not contain a model, provider, tools, temperature, output limit, or Gateway handle.

The message contract is reused through the narrow `@caelush/llm/messages` subpath. Context does not import the `@caelush/llm` runtime root, a provider adapter, AI SDK types, or an `LLMRequest` implementation. A caller can add its own model and tools later and validate `{ model, messages }` with `LLMRequestSchema`.

## Message order

The final order is fixed:

```text
System
↓
Recent History
↓
Relevant File Reference (when non-empty)
↓
Current User
```

There is exactly one generated system message, and the current user message is copied as the final structured message without trimming, rewriting, summarizing, or merging synthetic context into it. History never contains a system message; the current system context is rebuilt for each model turn.

## System context and privilege layers

The system message sections are ordered as base system prompt (when non-empty), Context Policy, runtime facts, project metadata, and project instructions. The layers have deliberately different meaning:

```text
Base System          = runtime instructions
Project Instructions = project-level instructions
Runtime Facts        = trusted observations
Project Metadata     = reference data
Project Files        = reference data
Current User         = current user instruction
```

The policy explicitly labels metadata and source files as reference data and says not to follow directives embedded in them unless the user request or project instructions require it. This explicit privilege labeling reduces ambiguity; it is not a claim that prompt injection has been solved or that this renderer is a security sandbox.

Runtime facts include workspace root, project root, cwd, platform, architecture, and host Node version. Paths are rendered with `/` separators while snapshot paths remain unchanged. Metadata includes ecosystems, language signals, package-manager evidence, monorepo state, root/active package metadata, tooling, and only the prioritized build/test/lint/typecheck/check/dev/start scripts. Script commands are bounded to 512 UTF-8 bytes.

Project instructions retain Phase 5A root-to-cwd order and provenance (`relativePath`, `kind`, `depth`, `truncated`) inside an explicit structured fence. XML-style attributes are escaped and instruction/file bodies use a CDATA-safe split for `]]>`; no XML parser is implied.

Relevant files are rendered as one synthetic `user` reference message. It contains only ordered selected sections, relative paths, content, and a combined `truncated` flag. Scores, ranking reasons, discovery diagnostics, absolute paths, and the complete plan remain in the report/runtime value rather than entering the model context. A project file can never become a system instruction merely because it contains imperative text.

## Conversation integrity and compaction boundary

History values are checked at runtime with `LLMMessageSchema`. Tool calls and results remain structured. A tool result must match a previous assistant call by both `toolCallId` and `toolName`; orphan, duplicate, missing, and malformed values fail with `ContextConversationError`. Parallel calls are supported and results may arrive in either order.

History is grouped at user-message boundaries. Selection keeps a newest contiguous suffix of complete groups and never splits a group. If older groups are dropped, `requiresCompaction` is true. If the newest group is too large, no partial history is selected and `latestTurnTooLarge` is reported. Phase 5C performs no LLM summarization and does not respond to the flag; a future AgentLoop owns any safe compaction lifecycle.

## Budget

`maxInputTokens` is required. It is the caller-supplied model-input planning budget after external reserves such as provider overhead, tool schemas, and reserved output. It is not a detected provider context window. The default estimator is `ceil(UTF-8 bytes / 3)` and is a planning heuristic, not provider billing truth.

Budgeting proceeds in this order:

```text
mandatory system + current user
        ↓
optional budget after safety margin
        ↓
40% conversation / 60% relevant files
        ↓
per-source caps
        ↓
one spillover pass for unused capacity
        ↓
rendered-message hard check
```

The mandatory system message and exact current user message are never silently dropped or truncated. If they plus the safety margin exceed the limit, the builder fails closed with `ContextBudgetExceededError`; its breakdown contains only token counts and limits, not raw prompts or file content.

Relevant-file fit measures the actual synthetic message, including policy text, paths, and structured fences. Whole sections are preferred. The final in-memory section may be further UTF-8/line-safely truncated when the remaining budget is at least `minRelevantFileTokens`; the report distinguishes original 5B truncation from 5C further truncation. If rendering overhead still exceeds the hard limit, the builder drops the last relevant file, then the oldest selected conversation turn, until the invariant is satisfied or mandatory overflow is reached.

## Phase boundary

Phase 5 ends at `BuiltModelContext`. The next phase is Phase 6 — AgentLoop, which may connect ContextBuilder to `LLMRequest`, `LLMGateway`, model decisions, and future tool/final paths. Phase 5C itself has no autonomous continuation, Tool execution, Runtime execution, Security permission flow, or Verification loop.
