# Agent Loop and Tool Contract Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Prove and, where necessary, repair the production Agent Loop, native Tool Calling wire contract, Tool guidance/exposure, failure recovery, and Web semantics using safe characterization tests and a real DeepSeek product-entry simulation.

**Architecture:** Preserve the existing \`AgentLoop → RunController → ToolBatchCoordinator → ToolDispatcher\` boundaries and the \`LLMGateway → OpenAICompatibleLLMProvider\` one-turn contract. Add model guidance beside \`ToolRegistration\`, derive active guidance and model definitions from one registry snapshot, reuse existing Project Intelligence/Git capability facts for exposure, and keep all diagnostics sanitized at the Provider boundary. Treat Verification as a separate downstream status and do not alter its implementation.

**Tech Stack:** TypeScript 6, Node.js 24, ESM, pnpm workspace, Vitest, React/ReactDOM server rendering, Fastify daemon entry, \`@ai-sdk/openai-compatible\`, AI SDK 7, AJV-backed Tool schema runtime, SQLite-backed durable execution stores.

**Spec:** \`docs/superpowers/specs/2026-09-04-agent-loop-tool-contract-audit-design.md\`

## Global Constraints

- Work only on \`codex/v1-agent-loop-tool-contract-audit\`; do not merge \`master\` and do not create a Git worktree.
- Preserve \`@caelush/protocol\` as the JSON-safe contract source of truth and keep public imports at package \`src/index.ts\` boundaries.
- \`AgentLoop\` must not know concrete Tool names, Dispatcher, Runtime, Storage, EventBus, Permission, or Verification implementations.
- \`ToolRegistry\` remains the only source of both model-visible definitions and executable handlers; duplicate names remain configuration errors.
- Provider adapters receive one Gateway-owned call id and one unchanged AbortSignal; they do not execute Tools, retry, timeout, or generate Caelush IDs.
- Do not log or persist API keys, Authorization, raw prompts, complete user content, raw Tool args/output, provider credentials, or hidden reasoning.
- Workspace paths remain workspace-relative and containment remains strict; absolute paths must not be accepted as a workaround.
- Do not add Phase 8/10/11/12/13/14 capabilities, a new state machine, a new Tool batch table, or a second environment scanner.
- Every behavior change follows TDD: write the focused failing test, run it and confirm the expected failure, implement the minimum behavior, then run the focused and relevant package tests.
- Before final claims run \`pnpm check\`, inspect \`git status --short\` and \`git diff\`, push the task branch, and compare local/remote task SHAs.

---

### Task 1: Baseline and external implementation characterization

**Files:**
- Modify: none in production code.
- Create: \`docs/superpowers/characterization/2026-09-04-agent-loop-tool-contract-audit-baseline.md\`
- Test: existing \`packages/llm/test/openai-compatible-compatibility.test.ts\`, \`packages/core/test/agent-loop-integration.test.ts\`, \`packages/storage/test/run-controller-tool-integration.test.ts\`, \`packages/tools/test/default-tools.test.ts\`

**Interfaces:**
- Consumes: current task branch baseline and the approved audit spec.
- Produces: an auditable baseline record containing branch/HEAD, current nine-tool catalog, current summary semantics, relevant entry points, and external Codex/Pi/DeepSeek patterns.

- [ ] **Step 1: Capture the clean starting state.**

Run:

\`\`\`powershell
git status --short
git branch --show-current
git rev-parse HEAD
git merge-base --is-ancestor df3f70f9d28099271b84fa635757e982bc444c89 HEAD
\`\`\`

Record the output without changing the working tree. Preserve and record any pre-existing user changes.

- [ ] **Step 2: Map the existing production seams.**

Read and record the roles of:

\`\`\`text
apps/daemon/src/daemon-composition.ts
packages/core/src/agent-loop.ts
packages/core/src/agent-loop-request.ts
packages/core/src/run-controller.ts
packages/tools/src/registry.ts
packages/tools/src/batch-coordinator.ts
packages/llm/src/gateway.ts
packages/llm/src/providers/openai-compatible/provider.ts
packages/llm/src/providers/openai-compatible/tools.ts
packages/llm/src/providers/openai-compatible/messages.ts
packages/core/src/agent-summary.ts
apps/web/src/components/timeline.ts
\`\`\`

Use \`rg\` to verify call sites for \`modelDefinitions()\`, \`buildAgentLLMRequest()\`, \`summarizeAgentDecision()\`, and \`reasoning.summary\`.

- [ ] **Step 3: Record external design evidence.**

Add concise notes and direct links to:

\`\`\`text
https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_executor.rs
https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/router.rs
https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/system-prompt.ts
https://github.com/fivewillow/badlogic-pi-mono/blob/main/packages/coding-agent/docs/extensions.md
https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md
https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md
\`\`\`

Summarize only schema projection, active exposure, prompt guidance, parsing, result reinjection, and termination. Do not copy provider-specific code.

- [ ] **Step 4: Review the characterization record.**

Every conclusion must be labeled \`CONFIRMED\`, \`PARTIALLY CONFIRMED\`, or \`REJECTED\`; do not assert the observed failure cause before a fixture reproduces it.

- [ ] **Step 5: Verify and commit the baseline.**

\`\`\`powershell
git diff --check
git add docs/superpowers/characterization/2026-09-04-agent-loop-tool-contract-audit-baseline.md
git commit -m "docs: characterize agent loop tool audit baseline"
\`\`\`

### Task 2: Capture the final OpenAI-compatible wire request safely

**Files:**
- Create: \`packages/llm/test/support/wire-trace.ts\`
- Create: \`packages/llm/test/openai-compatible-wire-contract.test.ts\`
- Modify: \`packages/llm/test/support/openai-compatible-sse.ts\` only for a multi-response helper.
- Modify: \`packages/llm/src/providers/openai-compatible/provider.ts\` only if the existing injected \`fetch\` path cannot be observed without changing behavior.

**Interfaces:**
- Consumes: \`OpenAICompatibleLLMProvider\`, \`LLMGateway\`, \`LLMRequest\`, and real OpenAI-shaped SSE helpers.
- Produces: a safe normalized request trace with message roles, tool names, schema hashes, tool choice, timing, finish reason, and decision metadata.

- [ ] **Step 1: Write the failing safe-trace test.**

\`\`\`ts
it("captures model-facing tools from the final adapter request without secrets", async () => {
  const bodies: unknown[] = [];
  const provider = createOpenAICompatibleLLMProvider({
    id: "deepseek",
    baseURL: "https://provider.invalid/v1",
    apiKey: "do-not-store-this-value",
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      return openAICompatibleSseResponse(finalTextSse("ok"));
    },
  });
  await new LLMGateway({ providers: registryOf(provider) }).complete(requestWithAllNineTools(), {
    signal: new AbortController().signal,
  });
  const trace = normalizeWireRequest(bodies[0]);
  expect(trace.toolNames).toEqual([
    "read_file", "list_directory", "find_files", "search_text", "apply_patch",
    "exec_command", "write_stdin", "git_status", "git_diff",
  ]);
  expect(JSON.stringify(trace)).not.toContain("do-not-store-this-value");
});
\`\`\`

Run:

\`\`\`powershell
pnpm exec vitest run packages/llm/test/openai-compatible-wire-contract.test.ts
\`\`\`

Expected: FAIL because the safe trace helper/test does not exist.

- [ ] **Step 2: Implement the narrow normalized trace helper.**

\`normalizeWireRequest()\` accepts \`unknown\` and keeps only \`model\`, role sequence/count, tool count/names, deterministic SHA-256 hashes of each \`{name, description, inputSchema}\` projection, \`toolChoice\`, and bounded metadata. It must not stringify or retain arbitrary message content, headers, or raw body.

- [ ] **Step 3: Run the focused test and inspect the captured request.**

Assert every schema has a unique name, non-empty description, object root, valid required fields/property types, and top-level \`additionalProperties: false\`. Assert execution-only fields and credential text are absent.

- [ ] **Step 4: Add a compact normalized schema snapshot.**

Snapshot only the ordered safe schema matrix, never the full prompt or request body.

- [ ] **Step 5: Run and commit the LLM characterization.**

\`\`\`powershell
pnpm exec vitest run packages/llm/test/openai-compatible-wire-contract.test.ts packages/llm/test/openai-compatible-tools.test.ts packages/llm/test/openai-compatible-messages.test.ts packages/llm/test/gateway-tool-stream.test.ts
git add packages/llm/test/support/wire-trace.ts packages/llm/test/openai-compatible-wire-contract.test.ts packages/llm/test/support/openai-compatible-sse.ts
git commit -m "test: characterize openai compatible tool wire contract"
\`\`\`

### Task 3: Prove provider Tool Call → Dispatcher → next Provider request

**Files:**
- Create: \`packages/storage/test/agent-tool-round-trip-wire.test.ts\`
- Modify: \`packages/llm/test/support/openai-compatible-sse.ts\` for a provider response sequence if required.
- Modify: \`packages/storage/test/run-controller-tool-integration.test.ts\` only to extract shared fixture helpers.

**Interfaces:**
- Consumes: existing daemon/storage composition fixtures, \`RunController\`, \`ToolBatchCoordinator\`, \`ToolDispatcher\`, injected Provider fetch, and durable execution stores.
- Produces: proof that provider \`toolCallId\` identity survives parsing, durable execution, result conversion, and second Provider request reinjection.

- [ ] **Step 1: Write the failing two-turn controller test.**

\`\`\`ts
it("reinjects the executed tool result with the same provider toolCallId", async () => {
  const requests: unknown[] = [];
  const provider = providerWithFetchSequence([
    toolCallSse({ id: "call_root_1", name: "list_directory", arguments: '{"path":"."}' }),
    finalTextSse("The workspace contains the requested files."),
  ], requests);
  const runtime = await createProductionRunFixture({ provider });
  const result = await runtime.startRunWithUserPrompt("请扫描分析当前工作区，这是只读任务。");
  expect(result.agentLoopFinalCandidate).toBeDefined();
  expect(runtime.executedToolNames()).toEqual(["list_directory"]);
  expect(parseCapturedRequest(requests[1]).toolResultCallIds).toEqual(["call_root_1"]);
});
\`\`\`

Run the test and confirm it fails because the production-entry fixture/assertion is absent.

- [ ] **Step 2: Implement only test support for the Provider response sequence.**

Use the injected \`fetch\` and existing storage fixture patterns. Return valid OpenAI-compatible SSE and never inspect or store Authorization.

- [ ] **Step 3: Run the test to characterize current behavior.**

Classify any failure as fixture, provider parsing, controller wiring, or result reinjection before changing production code.

- [ ] **Step 4: Add Tool-error reinjection.**

Request \`list_directory\` with an invalid argument, assert the next Provider request contains a \`role: "tool"\` message with the same ID and safe \`isError\` content, and assert the handler is not rerun unless the Provider explicitly requests a corrected call.

- [ ] **Step 5: Implement the smallest production correction identified by the red test.**

Preserve assistant source order, exactly one result per requested call, and existing durable boundaries. Do not move execution into the Provider adapter or AgentLoop.

- [ ] **Step 6: Run and commit the round-trip proof.**

\`\`\`powershell
pnpm exec vitest run packages/storage/test/agent-tool-round-trip-wire.test.ts packages/storage/test/run-controller-tool-integration.test.ts packages/core/test/agent-tool-results.test.ts packages/llm/test/openai-compatible-messages.test.ts
git add packages/storage/test/agent-tool-round-trip-wire.test.ts packages/llm/test/support/openai-compatible-sse.ts packages/storage/test/run-controller-tool-integration.test.ts
git commit -m "test: prove tool call result round trip"
\`\`\`

### Task 4: Add model guidance and the Core Agent Policy

**Files:**
- Create: \`packages/tools/src/model-guidance.ts\`
- Modify: \`packages/tools/src/registration.ts\`, \`packages/tools/src/registry.ts\`, \`packages/tools/src/registry-builder.ts\`, \`packages/tools/src/index.ts\`
- Modify: all nine built-in registration files under \`packages/tools/src/builtins/\`
- Create: \`packages/tools/test/model-guidance.test.ts\`
- Modify: \`apps/daemon/src/daemon-composition.ts\`
- Create: \`apps/daemon/test/agent-policy.test.ts\`

**Interfaces:**
- Consumes: immutable \`ToolRegistry\`, existing registrations, and \`RunExecutionConfig.baseSystemPrompt\`.
- Produces: \`ToolModelGuidance\`, \`ToolRegistry.modelGuidance()\`, concise per-tool guidance, and a stable default Core Agent Policy.

- [ ] **Step 1: Write failing guidance contract tests.**

\`\`\`ts
it("keeps model guidance separate from the provider ToolDefinition", () => {
  const registry = registryWithRegistration({
    definition: definition("read_file"),
    modelGuidance: { summary: "Read a text file.", guidelines: ["Use a workspace-relative path."] },
    handler: noopHandler(),
  });
  expect(registry.modelGuidance()).toEqual([
    { name: "read_file", summary: "Read a text file.", guidelines: ["Use a workspace-relative path."] },
  ]);
  expect(registry.modelDefinitions()[0]).not.toHaveProperty("modelGuidance");
});

it("assembles guidance only for active registry tools", () => {
  const prompt = assembleToolGuidance(activeRegistryWith("read_file"));
  expect(prompt).toContain("read_file");
  expect(prompt).not.toContain("git_status");
});
\`\`\`

Run the focused test and confirm it fails because the guidance contract is absent.

- [ ] **Step 2: Implement the data-only guidance type and registry projection.**

Clone/freeze \`summary\` and \`guidelines\` at registration/build boundaries, validate non-empty bounded strings, and return ordered snapshots from the same registry used by \`modelDefinitions()\` and \`resolve()\`.

- [ ] **Step 3: Add concise guidance to each built-in.**

Guidance must cover:

\`\`\`text
read_file: bounded UTF-8 text; workspace-relative file path; not for directories.
list_directory: immediate children; "." is workspace root; paginate with offset/limit.
find_files: bounded workspace-relative glob discovery; do not pass absolute patterns.
search_text: bounded regex search; target paths/includes; invalid regex is recoverable.
apply_patch: only when changes are requested; never for read-only inspection.
exec_command: only for explicitly needed commands; not a substitute for read-only tools.
write_stdin: continue an owned exec_command session only.
git_status: only in a Git repository; stop after NOT_A_GIT_REPOSITORY.
git_diff: bounded Git changes only; not generic file discovery.
\`\`\`

Add short path, pagination, important-error, and environment bullets without placing runtime metadata in Provider schemas.

- [ ] **Step 4: Add the default Core Agent Policy.**

Use one short daemon constant covering workspace operation, evidence before claims, \`.\` root, Tool errors as observations, corrected recoverable errors, no repeated unchanged failures, no inapplicable tools, no mutation for read-only work, evidence-sufficient stopping, explicit blockers, and no chain-of-thought request.

- [ ] **Step 5: Run and commit guidance/policy tests.**

\`\`\`powershell
pnpm exec vitest run packages/tools/test/model-guidance.test.ts packages/tools/test/registry.test.ts packages/tools/test/catalog-consistency.test.ts apps/daemon/test/daemon-composition.test.ts apps/daemon/test/agent-policy.test.ts
git add packages/tools/src packages/tools/test/model-guidance.test.ts apps/daemon/src/daemon-composition.ts apps/daemon/test/agent-policy.test.ts
git commit -m "feat: add model tool guidance and agent policy"
\`\`\`

### Task 5: Make list-directory root semantics and Git errors explicit

**Files:**
- Modify: \`packages/tools/src/builtins/list-directory.ts\`, \`packages/tools/src/builtins/git-status.ts\`, \`packages/tools/src/builtins/git-diff.ts\`
- Modify: \`packages/runtime/src/git/errors.ts\` and the existing typed boundary in \`packages/runtime/src/git/service.ts\` or \`git-runner.ts\`
- Create: \`packages/tools/test/list-directory-root.test.ts\`
- Modify: \`packages/runtime/test/git-runtime.test.ts\`, \`packages/tools/test/git-tools.test.ts\`

**Interfaces:**
- Consumes: \`WorkspacePathResolver\`, existing Git runner/service errors, schema validation, and bounded result helpers.
- Produces: explicit root-path behavior, strict absolute-path rejection, and stable \`NOT_A_GIT_REPOSITORY\` model-facing result.

- [ ] **Step 1: Write failing root and Git error tests.**

\`\`\`ts
it("lists the workspace root with an explicit dot path", async () => {
  const result = await executeTool("list_directory", { path: "." });
  expect(result.isError).toBe(false);
  expect(result.details).toMatchObject({ path: "." });
});

it("rejects an absolute list-directory path", async () => {
  const result = await executeTool("list_directory", { path: process.cwd() });
  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
});

it("returns NOT_A_GIT_REPOSITORY outside a Git workspace", async () => {
  const result = await executeTool("git_status", {});
  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({ code: "NOT_A_GIT_REPOSITORY" });
});
\`\`\`

Run and confirm the failure is caused by current behavior, not the fixture.

- [ ] **Step 2: Characterize the durable first failure.**

Use a short-lived non-Git workspace and record only \`toolName\`, safe argument classification (\`relative\`/\`absolute\`), status, public error code, and sanitized observation details.

- [ ] **Step 3: Implement the smallest root correction.**

If omission of \`path\` is the observed cause, make \`list_directory.path\` optional with default \`.\` in schema, handler, guidance, and tests. If the cause is an absolute/non-directory path, keep the field required and update guidance/error handling only. Never weaken containment.

- [ ] **Step 4: Implement typed Git repository absence mapping.**

Map the existing repository-discovery result at the Runtime Git boundary to a typed not-found condition and then to Tool result \`NOT_A_GIT_REPOSITORY\`. Preserve normal non-zero exit semantics for actual Git commands.

- [ ] **Step 5: Run and commit path/Git semantics.**

\`\`\`powershell
pnpm exec vitest run packages/tools/test/list-directory-root.test.ts packages/tools/test/git-tools.test.ts packages/runtime/test/git-runtime.test.ts packages/runtime/test/workspace-path.test.ts
git add packages/tools/src/builtins/list-directory.ts packages/tools/src/builtins/git-status.ts packages/tools/src/builtins/git-diff.ts packages/runtime/src/git packages/tools/test/list-directory-root.test.ts packages/tools/test/git-tools.test.ts packages/runtime/test/git-runtime.test.ts
git commit -m "fix: clarify workspace root and non git tool errors"
\`\`\`

### Task 6: Add environment-aware Git Tool exposure

**Files:**
- Create: \`packages/tools/src/tool-exposure.ts\`
- Modify: \`packages/tools/src/registry.ts\`, \`packages/tools/src/registry-builder.ts\`, \`packages/tools/src/index.ts\`
- Modify: \`apps/daemon/src/daemon-composition.ts\` and the existing run configuration resolver seam where workspace/project facts enter composition.
- Create: \`packages/tools/test/tool-exposure.test.ts\`
- Modify: \`apps/daemon/test/daemon-composition.test.ts\`

**Interfaces:**
- Consumes: existing Project Inspector/Project Intelligence and Runtime Git capability/discovery.
- Produces: one filtered immutable registry where non-Git workspaces omit Git tools, Git workspaces retain them, and definitions/guidance/resolve remain aligned.

- [ ] **Step 1: Write failing exposure tests.**

\`\`\`ts
it("hides Git tools in a known non-Git workspace", async () => {
  const registry = await buildActiveRegistry({ isGitRepository: false });
  expect(registry.names()).not.toContain("git_status");
  expect(registry.names()).not.toContain("git_diff");
  expect(registry.modelGuidance().map((item) => item.name)).not.toContain("git_status");
});

it("keeps Git tools in a Git workspace", async () => {
  const registry = await buildActiveRegistry({ isGitRepository: true });
  expect(registry.names()).toContain("git_status");
  expect(registry.names()).toContain("git_diff");
  expect(registry.resolve("git_status")).toBeDefined();
});
\`\`\`

Run and confirm the current always-nine-tool catalog fails the non-Git expectation.

- [ ] **Step 2: Implement an explicit active-tool projection.**

Filter existing registrations from one environment capability input before building the immutable registry. Do not scan recursively from Tool Router. Keep unknown capability explicit and document its behavior in the report.

- [ ] **Step 3: Prove catalog alignment.**

Assert every model definition is resolvable, every active resolution appears once, and every guidance entry names an active definition. Keep order stable after filtering.

- [ ] **Step 4: Run and commit exposure.**

\`\`\`powershell
pnpm exec vitest run packages/tools/test/tool-exposure.test.ts packages/tools/test/catalog-consistency.test.ts apps/daemon/test/daemon-composition.test.ts packages/security/test/secure-composition.test.ts
git add packages/tools/src/tool-exposure.ts packages/tools/src/registry.ts packages/tools/src/registry-builder.ts packages/tools/src/index.ts apps/daemon/src/daemon-composition.ts packages/tools/test/tool-exposure.test.ts apps/daemon/test/daemon-composition.test.ts
git commit -m "feat: expose git tools by workspace capability"
\`\`\`

### Task 7: Add safe model wire diagnostics and correct decision-summary semantics

**Files:**
- Create: \`packages/llm/src/wire-diagnostic.ts\`
- Modify: \`packages/llm/src/index.ts\` and the existing Provider-turn event seam in \`packages/llm/src/gateway.ts\`
- Create: \`packages/llm/test/wire-diagnostic.test.ts\`
- Modify: \`packages/core/src/agent-summary.ts\` only if a semantic helper is required.
- Modify: \`apps/web/src/components/timeline.ts\`, \`apps/web/test/timeline.test.tsx\`, and the existing client timeline presentation projection if the label is produced there.

**Interfaces:**
- Consumes: existing LLM events, deterministic \`summarizeAgentDecision()\`, client TimelineEntry projection, and public Tool error codes.
- Produces: opt-in safe trace, actual Provider timing, “决策摘要”/“Agent 决策” presentation, and safe Tool failure cards.

- [ ] **Step 1: Write failing redaction and UI tests.**

\`\`\`ts
it("does not include secrets, prompts, args, output, or hidden reasoning in the wire trace", () => {
  const trace = createSafeModelWireTrace({
    apiKey: "secret-key",
    authorization: "Bearer secret-key",
    systemPrompt: "private prompt",
    userContent: "private user content",
    toolArgs: { path: "C:/private" },
    toolOutput: "private output",
    reasoningContent: "hidden reasoning",
  });
  expect(JSON.stringify(trace)).not.toMatch(/secret-key|private prompt|private user content|C:\\\\private|private output|hidden reasoning/u);
});

it("labels deterministic decision summaries accurately", () => {
  const html = renderToStaticMarkup(<Timeline timeline={timelineWithReasoningSummary()} />);
  expect(html).toContain("决策摘要");
  expect(html).not.toContain("推理摘要");
});

it("shows a safe Tool error code without raw arguments", () => {
  const html = renderToStaticMarkup(<Timeline timeline={timelineWithToolError("NOT_A_GIT_REPOSITORY")} />);
  expect(html).toContain("NOT_A_GIT_REPOSITORY");
  expect(html).not.toContain("C:\\\\private");
});
\`\`\`

Run and confirm the current label/redaction behavior fails where characterized.

- [ ] **Step 2: Implement the diagnostic behind \`CAELUSH_DEBUG_MODEL_WIRE=1\`.**

Default off. Hash schemas deterministically, bound arrays/counts, and emit only the approved safe fields. Keep Provider SDK types private.

- [ ] **Step 3: Add actual Provider timing.**

Keep \`llm.started\`, \`llm.completed\`, and duration separate from the deterministic summary rendering time.

- [ ] **Step 4: Correct Web terminology and failure cards.**

Change only public presentation labels and safe error-code rendering. Continue filtering raw Tool output/details and never add raw arguments to Protocol/client state.

- [ ] **Step 5: Run and commit diagnostics/UI semantics.**

\`\`\`powershell
pnpm exec vitest run packages/llm/test/wire-diagnostic.test.ts packages/client/test/timeline-reducer.test.ts apps/web/test/timeline.test.tsx apps/web/test/daemon-timeline-e2e.test.ts
git add packages/llm/src/wire-diagnostic.ts packages/llm/src/index.ts packages/llm/src/gateway.ts packages/llm/test/wire-diagnostic.test.ts apps/web/src/components/timeline.ts apps/web/test/timeline.test.tsx packages/client/src/timeline
git commit -m "fix: clarify model diagnostics and decision summaries"
\`\`\`

### Task 8: Run the real DeepSeek A/B product-entry simulation

**Files:**
- Create: \`scripts/agent-loop-tool-contract-audit.mjs\` or a TypeScript script following existing daemon fixture conventions.
- Create: \`apps/daemon/test/agent-loop-tool-contract-real-provider.test.ts\`
- Create: \`apps/daemon/test/support/agent-loop-audit-fixture.ts\`
- Create: \`docs/superpowers/reports/2026-09-04-agent-loop-tool-contract-audit.md\`
- Modify: \`.gitignore\` only if needed for local trace scratch output; never ignore the final report.

**Interfaces:**
- Consumes: actual daemon/product entry, Session/Run/start path, event stream, active registry, environment variables, and OpenAI-compatible DeepSeek provider.
- Produces: bounded Non-Git/Git traces, durable Invocation/Observation summaries, \`AGENT_LOOP_FINAL_CANDIDATE\`, separate \`RUN_FINAL_STATUS\`, and safe blocked status when credentials are missing.

- [ ] **Step 1: Write the failing preflight test.**

\`\`\`ts
it("reports provider preflight presence without printing credential values", () => {
  const status = providerEnvPresence(process.env);
  expect(Object.values(status).every((value) => value === "PRESENT" || value === "MISSING")).toBe(true);
  expect(JSON.stringify(status)).not.toContain(process.env.CAELUSH_PROVIDER_API_KEY ?? "__missing__");
});
\`\`\`

Missing configuration may produce \`REAL_PROVIDER_TEST_BLOCKED\`; it must not substitute a fake Provider while claiming a live pass.

- [ ] **Step 2: Implement bounded fixture creation.**

Create exactly:

\`\`\`text
package.json
pnpm-workspace.yaml
README.md
apps/web/src/main.ts
apps/api/src/server.ts
packages/shared/src/index.ts
\`\`\`

Create a second copy and run \`git init\`, \`git add\`, and optionally an initial commit. Cleanup must be scoped to the fixture directory.

- [ ] **Step 3: Run through the actual Product Entry.**

Create Session, Run, and start through the daemon/Web path; attach the event stream and collect only safe Provider/event traces. Do not use \`AgentLoop.run()\` as the E2E entry. Use the exact approved read-only user prompt.

- [ ] **Step 4: Enforce the twelve-turn bound.**

Count Provider turns per fixture. At 13, stop and record \`REAL_AGENT_LOOP_NOT_CONVERGING\`.

- [ ] **Step 5: Persist the safe result.**

Record environment, PRESENT/MISSING status, visible tools, turn count, tool names, safe argument classifications, error codes, recovery/repetition behavior, \`AGENT_LOOP_FINAL_CANDIDATE\`, and \`RUN_FINAL_STATUS\`. Exclude secrets, absolute user paths, raw prompt/content, raw args/output, unnecessary internal IDs, and hidden reasoning.

- [ ] **Step 6: Verify the production gate.**

When credentials are present, require Non-Git to reach Agent Loop \`FINAL_CANDIDATE\`. If Verification blocks later completion, record \`AGENT_LOOP = PASS\` and \`VERIFICATION = KNOWN BLOCKER\` separately. If credentials are missing, record \`REAL_PROVIDER_TEST_BLOCKED\`.

- [ ] **Step 7: Run once within the API bound.**

\`\`\`powershell
pnpm exec vitest run apps/daemon/test/agent-loop-tool-contract-real-provider.test.ts
\`\`\`

Keep the test serial and output safe status/trace fields only.

- [ ] **Step 8: Commit the live harness and initial report.**

\`\`\`powershell
git add scripts/agent-loop-tool-contract-audit.mjs apps/daemon/test/agent-loop-tool-contract-real-provider.test.ts apps/daemon/test/support/agent-loop-audit-fixture.ts docs/superpowers/reports/2026-09-04-agent-loop-tool-contract-audit.md .gitignore
git commit -m "test: audit real deepseek agent loop"
\`\`\`

### Task 9: Independent review, final report, and delivery gates

**Files:**
- Modify: \`docs/superpowers/reports/2026-09-04-agent-loop-tool-contract-audit.md\`
- Create: \`docs/superpowers/characterization/2026-09-04-agent-loop-tool-contract-audit-review.md\`

**Interfaces:**
- Consumes: focused test output, safe live traces, fixture results, schema matrix, Web tests, and final diff.
- Produces: independent review verdict for the 16 reviewer checks and requested A–K report sections.

- [ ] **Step 1: Dispatch independent review with \`gpt-5.6-luna\` if a sub-agent is used.**

Review schema completeness/mapping, exposure, policy/guidance, Provider-originated Tool Call parsing, Dispatcher execution, result reinjection and IDs, path/Git failure causes, recovery, reasoning UI/timing, secret/raw-args/hidden-CoT boundaries, and real DeepSeek evidence. Do not use \`gpt-5.6-sol\`; verify all claims against the actual diff and tests.

- [ ] **Step 2: Complete the final report with exactly these sections.**

\`\`\`text
# A. Executive Verdict
# B. Actual Wire Contract
# C. Failed list_directory
# D. Failed git_status
# E. Tool Schema Matrix
# F. System Prompt
# G. Real DeepSeek Run
# H. Reasoning UI
# I. Security
# J. Tests
# K. Known Separate Blocker
\`\`\`

Label every conclusion \`CONFIRMED\`, \`PARTIALLY CONFIRMED\`, or \`REJECTED\`, point to a test/trace/fixture, and emit \`READY FOR AGENT LOOP / TOOL CALLING MANUAL REVIEW\` only after all required gates pass or are explicitly blocked.

- [ ] **Step 3: Run complete verification.**

\`\`\`powershell
pnpm check
git diff --check
git status --short
git diff --stat
\`\`\`

Read the full output and resolve failures before making success claims.

- [ ] **Step 4: Push and compare local/remote task SHAs.**

\`\`\`powershell
git push -u origin codex/v1-agent-loop-tool-contract-audit
git rev-parse HEAD
git ls-remote origin refs/heads/codex/v1-agent-loop-tool-contract-audit
\`\`\`

Record \`LOCAL_TASK_SHA\` and \`REMOTE_TASK_SHA\` in the report and require exact equality. Do not merge \`master\`.

- [ ] **Step 5: If the final report changes after push, commit, push again, and repeat the SHA comparison.**

