# Caelush Phase 6B Resumable Agent Loop Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

Goal: 在包含 Phase 6A 合约的基线上实现一个每次最多推进一个 LLM Provider Turn、可在外部 Tool Boundary 后恢复的 Context → LLM Resumable Decision Loop。

Architecture: @caelush/core 提供注入式 AgentLoop ports，按 Step Gate → ProjectInspector → RelevantFilePlanner → ContextBuilder → LLMRequest → AgentLLMClient 顺序编排；Loop 在 Tool Calls 或 Final Candidate 处停止，不执行 Tool、不接 Storage/EventBus/Verification。ContextBuilder 将 Previous Completed History 与 mandatory Current Turn 分离，Resume 携带完整 open user/tool turn 并按 request source order 规范化 Tool Results。

Tech Stack: TypeScript 6, NodeNext ESM, pnpm workspaces, Zod schemas, Vitest, existing @caelush/protocol, @caelush/context, and provider-independent @caelush/llm subpaths.

Spec: User-provided Phase 6B workflow in C:\Users\韩吉衍\.codex\attachments\73b4cdac-7235-4569-9ee5-9625e61e6e6b\pasted-text.txt.

## Global Constraints

- Base must contain Phase 6A SHA c92a64ae75ab6de3304bd4cec270e02b670ad537; current base is origin/codex/phase-6a-agent-kernel-contracts, not origin/master.
- Work only in .worktrees/phase-6b-resumable-agent-loop on codex/phase-6b-resumable-agent-loop; never reset, force-push, merge master, or create a PR.
- Each AgentLoop.run() or resumeWithToolResults() invocation performs at most one AgentLLMClient.complete() call.
- Phase 6B must not own ToolRegistry, ToolDispatcher, Tool execution, ToolInvocation creation, Storage, EventBus, SSE, RunController, Run-level cancellation, retry, doom-loop detection, Verification execution, or COMPLETED transitions.
- Core may import only @caelush/protocol, @caelush/context, and @caelush/llm/messages, @caelush/llm/turn, @caelush/llm/request, @caelush/llm/errors; never @caelush/llm root or AI SDK/runtime/host execution types.
- Runtime failures return sanitized AgentLoopFailureResult; caller contract violations throw AgentLoopInputError.
- A failed Provider Turn settles a failed AgentStep and increments usage.steps; Context preparation failure happens before Step creation and does not increment it.
- The current open user/tool turn is mandatory and can never be partially dropped; previous completed turns and relevant files remain optional budgeted context.
- Tool Results are normalized with Phase 6A normalizeToolResultBatch(); normalized results are persisted in source request order by messagesToAppend.
- Do not mutate run, state, history, tools, pendingDecision, or toolResults.
- Do not use Date.now(), randomUUID(), filesystem, network, child_process, or explicit any in Core production code.
- Preserve Phase 5 user-mode behavior and historical formatting debt; format all changed files only.
- TDD is mandatory: for every production behavior, write a failing test, run it and observe the expected failure, implement the minimum, rerun green, then refactor while green.

## Architecture References

| Source                                                                                                           | Observed design                                                                                                                                                                       | Caelush adoption                                                                                                                                                                                  | Intentional divergence                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex turn.rs: https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs                | A user turn owns a sequence of sampling steps; step context is captured before sampling, model follow-up is explicit, and stop/error boundaries are handled by the turn orchestrator. | Rebuild ProjectInspector/Planner/ContextBuilder state before each provider turn; make one AgentStep correspond to one provider attempt; return explicit outcome/failure at the external boundary. | No internal continuation loop, no tool execution, no Codex-specific hooks/compaction/cancellation machinery.     |
| Pi agent-loop.ts and types.ts: https://github.com/earendil-works/pi/tree/main/packages/agent                     | Tool results are appended before the next provider turn; continuation needs prior assistant tool-call context and current context mutates across tool cycles.                         | Resume validates pending assistant identity, carries one complete open user/tool turn, normalizes source order, and re-inspects the workspace.                                                    | Pi's low-level loop may execute tools; Caelush yields TOOL_CALLS_REQUESTED to an external tool system and stops. |
| OpenCode processor.ts: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts | Provider/tool lifecycle is represented by explicit processor results with deterministic stop/continue/error boundaries.                                                               | AgentLoopExecutionResult explicitly distinguishes OUTCOME from FAILED and never infers completion from natural-language text.                                                                     | No OpenCode session processor, persistence, event trace, retry, or host/runtime coupling in Phase 6B.            |

## File Map

- Modify packages/llm/package.json and packages/llm/src/index.ts; add request/errors subpath tests.
- Modify packages/context/src/context-builder.ts, context-budget.ts, context-build-report.ts, conversation-history.ts, errors.ts, index.ts; add continuation and mandatory-current-turn tests.
- Modify packages/core/package.json and packages/core/src/index.ts; create agent-loop.ts, agent-loop-ports.ts, agent-loop-input.ts, agent-loop-history.ts, agent-loop-request.ts, agent-error-mapper.ts; add focused core tests and real integration tests.
- Modify tests/architecture/package-boundaries.test.ts, docs/architecture/agent-loop.md, README.md, and AGENTS.md.
- Do not add Storage, Events, Tools, Runtime, Security, Verification, daemon, or app integrations.

### Task 1: Expose provider-independent LLM request and error subpaths

Files:

- Modify packages/llm/package.json and packages/llm/src/index.ts if needed.
- Test packages/llm/test/request-subpath.test.ts and packages/llm/test/errors-subpath.test.ts.

Interfaces:

- @caelush/llm/request exports only LLMRequestSchema, LLMRequest, LLMToolChoiceSchema, LLMToolChoice.
- @caelush/llm/errors exports LLMError, all existing LLM error classes, LLMErrorCode, and LLMErrorContext.
- Subpaths export no Gateway, registry, adapter, or AI SDK symbols.

- [ ] Step 1: Write failing tests importing both subpaths, parsing a valid request, constructing LLMNetworkError, and asserting Gateway/adapter symbols are absent.
- [ ] Step 2: Run pnpm vitest run packages/llm/test/request-subpath.test.ts packages/llm/test/errors-subpath.test.ts; expect missing-export failure.
- [ ] Step 3: Add package exports for ./request and ./errors pointing to existing provider-independent dist modules.
- [ ] Step 4: Run pnpm build && pnpm vitest run packages/llm/test/request-subpath.test.ts packages/llm/test/errors-subpath.test.ts; expect PASS.
- [ ] Step 5: Format only changed files and commit feat(llm): expose request and error contracts.

### Task 2: Add mandatory Current Turn and Tool Continuation context

Files:

- Modify packages/context/src/context-builder.ts, context-budget.ts, context-build-report.ts, conversation-history.ts, errors.ts, index.ts.
- Test packages/context/test/context-builder.test.ts, context-budget.test.ts, and new context-continuation.test.ts.

Interfaces:

- ContextBuildInput becomes a union of UserTurnContextBuildInput and ToolContinuationContextBuildInput. Common fields are baseSystemPrompt, snapshot, relevantFiles?, history?, and limits. User mode has optional mode USER_TURN and currentUserMessage. Continuation mode has mode TOOL_CONTINUATION and currentTurnMessages.
- Add ContextCurrentTurnReport with type USER_TURN or TOOL_CONTINUATION, messageCount, and estimatedTokens; add currentTurn to ContextBuildReport.
- Add currentTurnTokens to ContextBudgetBreakdown and retain currentUserTokens, setting it to zero for continuation.
- Continuation validation rejects empty/system messages, requires exactly one validateAndGroupConversation group, and requires a final tool result.
- Budget includes System plus the whole current turn; only old completed groups and relevant files are droppable. Message order is System → old history → relevant-file synthetic user → current turn.

- [ ] Step 1: Write failing tests for a single user/assistant-tool/tool continuation, two cycles, tiny optional budget preservation, overflow rejection, file-before-current-tail ordering, and no duplicated original user.
- [ ] Step 2: Run focused context tests and observe missing mode/mandatory-turn behavior.
- [ ] Step 3: Implement a current-turn message list, validate it with existing conversation grouping, extend budget assembly with a mandatory message sequence, and keep User mode compatible.
- [ ] Step 4: Run pnpm build && pnpm vitest run packages/context/test/context-builder.test.ts packages/context/test/context-budget.test.ts packages/context/test/context-continuation.test.ts.
- [ ] Step 5: Run all context tests for Phase 5 regression.
- [ ] Step 6: Format changed files and commit feat(context): support mandatory tool continuation turns.

### Task 3: Define Core AgentLoop ports, inputs, and result contracts

Files:

- Modify packages/core/package.json and packages/core/src/index.ts.
- Create packages/core/src/agent-loop-ports.ts, agent-loop-input.ts, and contract shell only where needed.
- Test packages/core/test/agent-loop-contracts.test.ts.

Interfaces:

- AgentProjectInspectorPort.inspect(input: ProjectInspectorInput): Promise<ProjectIntelligenceSnapshot>.
- AgentRelevantFilePlannerPort.plan(input: RelevantFilePlannerInput): Promise<RelevantFileContextPlan>.
- AgentContextBuilderPort.build(input: ContextBuildInput): BuiltModelContext.
- AgentLLMClient.complete(request: LLMRequest): Promise<LLMTurnResult>.
- AgentClock.now(): TimestampMs.
- AgentStepIdFactory.create(): StepId.
- AgentLoopDependencies holds inspector, planner, contextBuilder, llmClient, clock, and stepIdFactory.
- AgentLoopCommonInput holds readonly run, state, history, baseSystemPrompt, contextLimits, tools?, modelSettings?, cwd?, explicitPaths?. Start is common input. Resume adds pendingDecision and toolResults.
- Results are OUTCOME/FAILED unions with optional step/contextReport and readonly messagesToAppend. Model settings are only maxOutputTokens, temperature, and toolChoice.

- [ ] Step 1: Write failing public contract tests constructing valid readonly inputs/results.
- [ ] Step 2: Run the focused test and observe missing exports/types.
- [ ] Step 3: Add interfaces and Core dependency edges; exclude the LLM root import.
- [ ] Step 4: Run focused build/typecheck/test.
- [ ] Step 5: Format and commit feat(core): define resumable agent loop ports.

### Task 4: Validate run/state identity and split the Resume current turn

Files:

- Create packages/core/src/agent-loop-history.ts.
- Modify packages/core/src/agent-errors.ts and packages/core/src/index.ts.
- Test packages/core/test/agent-loop-input.test.ts and agent-loop-history.test.ts.

Interfaces:

- Export AgentLoopInputError publicly; keep splitter/tail checker private.
- Validate RUNNING status, matching run/state ids, session, goal, workspace, runtime, permissionProfile, approvalPolicy, and no active step.
- Resume history must be valid, end in the pending assistant, and have matching tool-call count/source order/id/name. Compare args semantically without object-key order. Reject already-present tool results and missing assistant.
- Normalize results with Phase 6A normalizeToolResultBatch before any port call; invalid batch throws AgentLoopInputError.
- Split at the latest user before pending assistant, or use a leading continuation from history start; append normalized results; require tool tail; old part remains complete turns.

- [ ] Step 1: Write failing tests for projection mismatch, active step, tail mismatch, missing assistant, duplicate result, unknown-tool acceptance, out-of-order normalization, multi-cycle split, key-order-independent args, and zero calls on invalid input.
- [ ] Step 2: Run focused tests and observe failure.
- [ ] Step 3: Implement private validation/splitting helpers without mutation or secret leakage.
- [ ] Step 4: Run focused tests plus all Phase 6A core tests.
- [ ] Step 5: Format and commit feat(core): validate resumable loop boundaries.

### Task 5: Implement per-step context preparation orchestration

Files:

- Create/modify packages/core/src/agent-loop.ts.
- Test packages/core/test/agent-loop-preparation.test.ts.

Interfaces:

- Preparation order is inspector.inspect({ workspace: run.workspace, cwd }) → planner.plan({ snapshot, query: { text: run.goal, explicitPaths? } }) → contextBuilder.build({ baseSystemPrompt, snapshot, relevantFiles, history, limits, currentUserMessage or continuation currentTurnMessages }).
- Both start and resume re-run all three ports; no global snapshot/plan cache.
- Gate precedes preparation. Start max-step returns MAX_STEPS_REACHED with user-only append; resume normalizes first, then gates, and returns result-only append. Both make zero preparation/provider calls when blocked.
- Context failures return FAILED with no step/report and unchanged usage; budget maps to BUDGET_EXCEEDED and other ContextError maps to INTERNAL_ERROR.

- [ ] Step 1: Write failing tests for strict call order, inspector input, query/default/explicit paths, zero-call max-step, re-inspection, context failure, and immutability.
- [ ] Step 2: Run tests and observe missing orchestration.
- [ ] Step 3: Implement preparation and max-step using evaluateAgentStepGate and markAgentStateMaxStepsReached without creating a Step.
- [ ] Step 4: Run focused and existing core tests.
- [ ] Step 5: Format and commit feat(core): build agent model turns from project context.

### Task 6: Build and validate the LLMRequest boundary

Files:

- Create packages/core/src/agent-loop-request.ts.
- Test packages/core/test/agent-loop-request.test.ts.

Interfaces:

- Build LLMRequest from BuiltModelContext.messages, run.model, optional tools, and modelSettings.
- Non-empty tools with omitted choice add AUTO; empty/undefined tools with omitted choice omit tools and choice. Preserve supplied tools/order/choice.
- Map only maxOutputTokens, temperature, toolChoice; never map run.limits.maxTokens, maxCost, or timeoutMs.
- Parse with LLMRequestSchema; keep composer private and never import LLM Gateway/root/Provider/AI SDK.

- [ ] Step 1: Write failing request tests for model/messages/tools/choice/settings, AUTO, omission, no limit leakage, schema parsing, and immutability.
- [ ] Step 2: Run focused tests and observe failure.
- [ ] Step 3: Implement the minimal composer.
- [ ] Step 4: Run focused tests and declaration/static import audits.
- [ ] Step 5: Format and commit feat(core): build provider-independent llm requests.

### Task 7: Implement Start AgentLoop.run() happy paths

Files:

- Modify packages/core/src/agent-loop.ts, agent-loop-ports.ts, agent-loop-input.ts, index.ts.
- Test packages/core/test/agent-loop.test.ts.

Interfaces:

- new AgentLoop(dependencies) exposes run(input: AgentLoopStartInput): Promise<AgentLoopExecutionResult> and resumeWithToolResults(input: AgentLoopResumeInput): Promise<AgentLoopExecutionResult>.
- After gate/context/request readiness, create exactly one Step via injected id/clock and createRunningAgentStep; begin state; invoke complete once.
- Use classifyAgentDecision and summarizeAgentDecision.
- Final completes Step, settles known usage, marks state VERIFYING; returns FINAL_CANDIDATE, step, report, and [currentUser, assistantMessage].
- Tool calls complete Step, settle state, keep RUNNING; returns TOOL_CALLS_REQUESTED, step/report, and [currentUser, assistantMessage]; never invokes a tool.
- Preserve goal exactly, with no trim/rewrite/summarize.

- [ ] Step 1: Write failing final/tool tests for order, lifecycle, one call, append semantics, and zero tool execution.
- [ ] Step 2: Run focused tests and observe failure.
- [ ] Step 3: Implement minimal start orchestration with one provider call.
- [ ] Step 4: Run focused/core/request suites.
- [ ] Step 5: Format and commit feat(core): add resumable agent decision loop.

### Task 8: Implement resumeWithToolResults() and multi-cycle continuation

Files:

- Modify packages/core/src/agent-loop.ts and agent-loop-history.ts.
- Test packages/core/test/agent-loop-resume.test.ts.

Interfaces:

- Resume sequence is validate projections → pending assistant/history → normalize batch → gate → re-inspect/re-plan/re-build continuation → request → one step/provider turn.
- Resume success appends normalized results plus new assistant; never appends original user or pending assistant.
- Second resume current turn is user, assistant A, tool A, assistant B, tool B; never only last pair.
- Relevant-file synthetic user stays before current continuation; synthetic context never enters append.
- Resume max-step returns normalized results only and does not call ports/LLM. Unknown tool names pass through.

- [ ] Step 1: Write failing tests for one resume final, two cycles, ordering, no duplicates, file ordering, max-step, and unknown tool.
- [ ] Step 2: Run focused tests and observe failure.
- [ ] Step 3: Implement split and continuation orchestration.
- [ ] Step 4: Run focused and all core tests.
- [ ] Step 5: Format and commit feat(core): support resumable tool-result continuation.

### Task 9: Map runtime/model/tool failures and settle failed steps

Files:

- Create packages/core/src/agent-error-mapper.ts.
- Modify packages/core/src/agent-loop.ts, agent-errors.ts, index.ts.
- Test packages/core/test/agent-loop-failures.test.ts.

Interfaces:

- Map LLM_NETWORK to NETWORK_ERROR, LLM_RATE_LIMIT to RATE_LIMIT, LLM_TIMEOUT to MODEL_TIMEOUT, all other LLMError to MODEL_ERROR; use phase LLM and preserve only retryable metadata. AgentModelOutputError maps MODEL_ERROR; AgentToolResultBatchError maps TOOL_OUTPUT_ERROR; ContextBudgetExceededError maps BUDGET_EXCEEDED; other ContextError maps INTERNAL_ERROR; unknown maps INTERNAL_ERROR.
- Use fixed generic messages; never copy raw errors or model/tool content. CAELUSH_LOOP_SECRET_DO_NOT_LEAK_42 must not occur in public result/error serialization.
- Provider/model failure occurs after Step begins: failAgentStep and settle state; schema-valid rejected turns preserve known usage, invalid/untrusted results settle without usage. Return FAILED with state RUNNING and no active step, incremented steps.
- Context failure occurs before Step: unchanged usage/no step. No retries, no state FAILED transition; RunController owns terminal projection.

- [ ] Step 1: Write failing failure tests for all listed error classes, known-usage LENGTH rejection, context/budget, tool batch, unknown, one-call/no-retry, failed step/state, and secret audit.
- [ ] Step 2: Run focused tests and observe failure.
- [ ] Step 3: Implement mapper and failure settlement.
- [ ] Step 4: Run focused and all core tests.
- [ ] Step 5: Format and commit feat(core): map agent loop runtime failures.

### Task 10: Finalize maxSteps and durable message semantics

Files:

- Modify packages/core/src/agent-loop.ts, agent-loop-input.ts, index.ts.
- Test packages/core/test/agent-loop-persistence.test.ts and agent-loop-max-steps.test.ts.

Interfaces:

- Start success append exact user+assistant; resume success append normalized tool results+assistant.
- Start provider failure append user only; resume provider failure after valid batch append normalized results only; invalid batch append [].
- Start max-step returns MAX_STEPS_REACHED, no Step/report, and user only; resume max-step returns same outcome, no Step/report, normalized results only.
- Synthetic system/runtime/project/relevant-file context is never appended.
- Freeze tests cover all input objects.

- [ ] Step 1: Write failing persistence/max-step/immutability tests.
- [ ] Step 2: Run and observe failure.
- [ ] Step 3: Implement exact append semantics and readonly handling.
- [ ] Step 4: Run focused and full core tests.
- [ ] Step 5: Format and commit test(core): cover resumable agent loop boundaries.

### Task 11: Real Context + real LLMGateway integration

Files:

- Create packages/core/test/agent-loop-integration.test.ts and optional test/support helpers.
- Modify packages/core/package.json only if an existing workspace dependency is needed; add no third-party package.

Interfaces:

- Use a temp fixture project with .git/, AGENTS.md, package.json, src/parser.ts, and src/parser.test.ts.
- Instantiate real ProjectInspector, RelevantFilePlanner, ContextBuilder, LLMProviderRegistry, and LLMGateway; inject gateway structurally as AgentLLMClient.
- Fake provider turn 1 returns read_file Tool Call; assert TOOL_CALLS_REQUESTED, completed Step, RUNNING state, usage.steps 1, user+assistant append, one request, and tool execution count 0.
- Test harness modifies parser.ts and supplies a valid LLMToolResultMessage; resume re-runs all context ports and second request contains full current turn plus updated parser content.
- Fake provider turn 2 returns STOP final; assert FINAL_CANDIDATE, VERIFYING, usage.steps 2, exactly two calls, no persistence/event/tool execution, never COMPLETED.
- Add maxSteps=1 integration: normalized results are appended but second provider call is zero.

- [ ] Step 1: Write the real integration test and observe RED.
- [ ] Step 2: Implement only test fixture adapters required by existing public ports.
- [ ] Step 3: Run focused integration test and verify GREEN.
- [ ] Step 4: Run context/llm/core integration suites.
- [ ] Step 5: Format and commit test(integration): exercise context to llm agent resume flow.

### Task 12: Architecture audits, documentation, and phase verification

Files:

- Modify tests/architecture/package-boundaries.test.ts, docs/architecture/agent-loop.md, README.md, AGENTS.md.
- Create docs/superpowers/plans/2026-08-28-caelush-phase-6b-resumable-agent-loop.md.

Requirements:

- Architecture tests allow Core → Context and only narrow LLM subpaths; reject Core → LLM root, Storage, Events, Tools, Runtime, Security, Verification, daemon, AI SDK, filesystem/network/child_process, Date.now/randomUUID, and explicit any.
- Docs cover flow diagram, resumability, Open User Turn, mandatory current turn, User Turn vs Agent Step, ordering, ledger semantics, error ownership, no retry, and excluded Phase 6C work.
- README may state context/LLM turn advancement and safe yields; never claim tool execution.
- AGENTS contains the Phase 6B guardrails from the workflow.
- Format only changed files; never fix historical 312-file format debt.

- [ ] Step 1: Write/update architecture tests; run them RED until behavior exists.
- [ ] Step 2: Update docs and guardrails.
- [ ] Step 3: Run static/declaration audits for packages/llm/dist/request.d.ts, errors.d.ts, and packages/core/dist/index.d.ts.
- [ ] Step 4: Run sequential verification: pnpm install --frozen-lockfile; pnpm lint; pnpm typecheck; pnpm test; pnpm build; prettier --check all changed files; pnpm format:check; pnpm check; git diff --check.
- [ ] Step 5: If needed, explicitly remove only generated apps/_/dist, packages/_/dist, and *.tsbuildinfo with safe paths, then reinstall/build sequentially; never git clean.
- [ ] Step 6: Commit docs/architecture changes, verify git status --short is clean.
- [ ] Step 7: Push and verify local HEAD equals git ls-remote origin refs/heads/codex/phase-6b-resumable-agent-loop.

## Acceptance Matrix

- Request/errors subpaths resolve and leak no Gateway/provider/SDK types.
- Context supports USER_TURN and TOOL_CONTINUATION; current turn is non-empty, one complete group, non-system, ends in tool, mandatory and never partially dropped; User mode remains compatible.
- Ports/results/public inputs exist; Core imports only allowed narrow contracts and Context.
- Run/state consistency, pending assistant identity/order/name, batch normalization, split, immutability, and unknown-tool pass-through are enforced.
- Gate precedes expensive work; max-step start/resume make zero preparation/provider calls and preserve user/tool facts.
- Each provider turn re-runs Inspector/Planner/Builder; no cache; request uses run.model and caller model settings; tools/choice forwarding is correct.
- One invocation means at most one provider call; no retry, tool execution, persistence, event bus, verification, RunController, terminal FAILED/COMPLETED state, or run cancellation.
- Final settles completed Step and VERIFYING; tool settles completed Step and RUNNING; failures settle failed Step and keep state RUNNING.
- Context failures occur before Step; model rejection settles failed Step and preserves known usage.
- Errors are sanitized; no sentinel leak.
- messagesToAppend contains only real user/assistant/tool messages with exact semantics.
- Real integration proves dynamic workspace re-observation and exactly two provider calls.
- Full lint/typecheck/test/build pass; changed-file format clean; historical format does not regress; diff check passes; branch pushed and clean.

## Verification Evidence Log

Record actual command outputs and counts during execution. Baseline:

- Phase 6A SHA c92a64ae75ab6de3304bd4cec270e02b670ad537.
- BASE_REF origin/codex/phase-6a-agent-kernel-contracts.
- Branch codex/phase-6b-resumable-agent-loop.
- Worktree D:\Develop\Caelush\.worktrees\phase-6b-resumable-agent-loop.
- Baseline lint/typecheck/build PASS.
- Baseline tests 99 files / 358 tests / 2 skipped after sequential build.
- Baseline full format 312 files failed.

Implementation evidence:

- TDD RED/GREEN was observed for LLM request/error subpaths, Context continuation, Core contracts/history, request composition, loop preparation, start/resume, failure mapping, and max-step behavior.
- Real integration test passed with a temporary `.git` fixture: two provider turns, external file change re-observed on resume, normalized tool results, and zero Tool execution.
- Focused architecture/static tests passed; Core production source has no root LLM, AI SDK, host execution, time/ID, ToolDispatcher, EventBus, or hidden-reasoning imports.
- Full test suite passed after updating the stale Phase 6A public-API assertion: 111 test files, 391 passed, 2 skipped.
- `pnpm lint` passed; `pnpm typecheck` passed; `pnpm build` passed.
- Changed-file Prettier checks passed for 35 files. Full repository format baseline was 312 failing files; the final run reported 296, so this phase did not increase the debt.
- Final `pnpm check` ran sequentially: lint, typecheck, test, and build passed; format check reported 296 repository files with historical formatting debt.
- Final commit before push: 62762c9 (`feat(core): add resumable agent decision loop`).
