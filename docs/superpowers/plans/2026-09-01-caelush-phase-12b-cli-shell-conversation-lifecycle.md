# Caelush V1 Phase 12B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the Phase 12B daemon-backed Ink CLI shell and the durable Session-to-Run verified conversation history path, while preserving the existing Core/Runtime/Tool/Verification ownership boundaries.

**Architecture:** Add a strict public `DaemonInfo.defaultRunConfiguration`, let the daemon derive a bounded `historyPrefix` from prior verified Runs, and let Core prepend that prefix without persisting it. Build the CLI as a thin `@caelush/client` consumer with a plain TypeScript controller, immutable view state, allowlisted event projection, one Session per process, one active Run, and Ink rendering of a static transcript plus dynamic status/composer.

**Tech Stack:** TypeScript ESM monorepo, pnpm workspaces, Zod protocol schemas, Vitest, Fastify daemon, SQLite repositories, React 19.2.8, Ink 7.1.1, `ink-text-input` 6.0.0, and `ink-testing-library` 4.0.0.

**Spec:** `docs/superpowers/specs/2026-09-01-caelush-phase-12b-cli-shell-conversation-lifecycle-design.md`

## Global Constraints

- Implement only Phase 12B; do not add a Phase 12 sub-round or implement the detailed timeline, reconnect/resume, approval UX, cancellation UX, auto-start, or packaging reserved for later rounds.
- The implementation branch is `codex/phase-12b-cli-shell-conversation-lifecycle` in worktree `.worktrees/phase-12b-cli-shell-conversation-lifecycle`, based on Phase 12A SHA `1f5fde1bfe71ce26e69c4dbb4d7831bd0b05a562`.
- The CLI imports only public `@caelush/client`, `@caelush/protocol`, React/Ink, and application-local modules; it never imports Core, Storage, Runtime, Security, Tools, Context, Verification, or LLM.
- The daemon remains the only local Agent composition root; Core receives history through data-only `RunExecutionConfig.historyPrefix?: readonly LLMMessage[]` and never queries Storage.
- Prior context contains only eligible verified completed Run goals and verified final texts; Tool calls/results, stdout/stderr, patches, reasoning, provider payloads, secrets, and invalid final results never enter Session history or CLI transcript.
- `ContextBuilder` remains the sole token authority; the daemon history provider bounds Runs but does not estimate, compact, or silently truncate message text.
- `RunController` generates the current user goal exactly once on fresh/retry/recover/repair paths and preserves the complete current open turn exactly once on Tool-result resume.
- Durable lifecycle state and canonical final results come from the daemon/client contract; the CLI never infers completion from natural-language output and never rewrites durable Run status.
- New or modified files must be formatted individually; do not run global `prettier --write`, and preserve the existing 724-file format baseline.
- Every behavior change follows red → green → refactor, and each completed task ends with a focused verification and a small commit.

---

### Task 1: Freeze repository context and validate the public contracts

**Files:**

- Read: `AGENTS.md`, `docs/superpowers/specs/2026-09-01-caelush-phase-12b-cli-shell-conversation-lifecycle-design.md`
- Read: `packages/protocol/src/api/daemon-info.ts`, `packages/protocol/src/api/index.ts`, `packages/protocol/src/index.ts`, `packages/core/src/run-controller-ports.ts`, `packages/core/src/run-controller.ts`, `packages/core/src/agent-loop.ts`, `packages/storage/src/repositories/run-repository.ts`, `packages/client/src/client.ts`
- Test: `packages/protocol/test/daemon-info.test.ts` and existing Core/daemon composition tests

**Interfaces:**

- Consumes: the Phase 12A baseline and the already committed design specification.
- Produces: a recorded list of existing schemas, repository ordering, controller execution boundaries, and event names used by later tasks.

- [ ] **Step 1: Recheck the isolated worktree and baseline commit.**

Run:

```powershell
git status --short
git rev-parse HEAD
git branch --show-current
```

Expected: the branch is `codex/phase-12b-cli-shell-conversation-lifecycle`, HEAD includes the design-spec commit, and no unrelated source changes are present.

- [ ] **Step 2: Inspect current APIs before changing them.**

Run:

```powershell
rg -n "interface RunExecutionConfig|executeLoop|resumeWithToolResults|listBySession|DaemonInfoSchema|AgentEventSchema|VerifiedRunFinalResultSchema" packages apps
```

Expected: the search confirms that `RunExecutionConfig` is Core-owned, `RunRepository.listBySession` is the existing Session query boundary, and `CaelushClient` already owns HTTP/SSE validation.

- [ ] **Step 3: Verify the existing contract tests are the regression guard.**

Run:

```powershell
pnpm exec vitest run packages/protocol/test apps/daemon/test/daemon-composition.test.ts --reporter=dot
```

Expected: the pre-change contract tests pass; any Windows timing issue is rerun serially with the repository’s existing test timeout before being classified as a regression.

- [ ] **Step 4: Commit only if the context audit changes documentation.**

No source change is expected in this task. If a factual correction is needed in the already committed design document, update only that document, run its targeted formatter check, and commit:

```powershell
pnpm exec prettier --check docs/superpowers/specs/2026-09-01-caelush-phase-12b-cli-shell-conversation-lifecycle-design.md
git add docs/superpowers/specs/2026-09-01-caelush-phase-12b-cli-shell-conversation-lifecycle-design.md
git commit -m "docs: clarify phase 12b contract characterization"
```

### Task 2: Add the strict daemon default Run configuration schema

**Files:**

- Modify: `packages/protocol/src/api/daemon-info.ts`
- Modify: `packages/protocol/src/api/index.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/daemon/src/daemon-composition.ts`
- Modify: `apps/daemon/test/daemon-composition.test.ts`
- Modify: `apps/daemon/test/daemon-production-e2e.test.ts`
- Test: `packages/protocol/test/daemon-info.test.ts`

**Interfaces:**

- Consumes: `RuntimeRefSchema`, `PermissionProfileSchema`, `ApprovalPolicySchema`, and `RunLimitsSchema` from Protocol.
- Produces: `DefaultRunConfigurationSchema`, `DefaultRunConfiguration`, and a required `DaemonInfo.defaultRunConfiguration` field with the V1 local defaults.

- [ ] **Step 1: Write failing schema tests.**

Add tests that assert the exact safe public value parses and that strictness rejects an extra field or an invalid runtime/policy/limit value:

```ts
const defaults = {
  runtime: { id: "local", kind: "local" },
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
  limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
} as const;

it("parses the public V1 default Run configuration", () => {
  expect(DefaultRunConfigurationSchema.parse(defaults)).toEqual(defaults);
});

it("rejects extra public default configuration fields", () => {
  expect(() => DefaultRunConfigurationSchema.parse({ ...defaults, endpoint: "secret" })).toThrow();
});
```

- [ ] **Step 2: Run the focused tests to verify the contract is absent.**

Run:

```powershell
pnpm exec vitest run packages/protocol/test/daemon-info.test.ts --reporter=dot
```

Expected: FAIL because the schema/export and required `DaemonInfo` field do not yet exist.

- [ ] **Step 3: Implement the minimal Protocol schema and exports.**

Define the data-only schema in `daemon-info.ts`:

```ts
export const DefaultRunConfigurationSchema = z
  .object({
    runtime: RuntimeRefSchema,
    permissionProfile: PermissionProfileSchema,
    approvalPolicy: ApprovalPolicySchema,
    limits: RunLimitsSchema,
  })
  .strict();
export type DefaultRunConfiguration = z.infer<typeof DefaultRunConfigurationSchema>;
```

Add `defaultRunConfiguration: DefaultRunConfigurationSchema` to `DaemonInfoSchema`, export the schema/type through both Protocol index files, and have `composeDaemon()` pass the frozen V1 defaults into `DaemonInfoSchema.parse()`.

- [ ] **Step 4: Update composition expectations and run tests.**

Update exact `DaemonInfo` fixtures to include the public defaults, then run:

```powershell
pnpm exec vitest run packages/protocol/test/daemon-info.test.ts apps/daemon/test/daemon-composition.test.ts apps/daemon/test/daemon-production-e2e.test.ts --reporter=dot --testTimeout=30000 --maxWorkers=1
```

Expected: PASS, with no endpoint, credential, database, or machine identity in the returned info.

- [ ] **Step 5: Format, typecheck, and commit.**

Run:

```powershell
pnpm exec prettier --write packages/protocol/src/api/daemon-info.ts packages/protocol/src/api/index.ts packages/protocol/src/index.ts apps/daemon/src/daemon-composition.ts packages/protocol/test/daemon-info.test.ts apps/daemon/test/daemon-composition.test.ts apps/daemon/test/daemon-production-e2e.test.ts
pnpm typecheck
git add packages/protocol apps/daemon
git commit -m "feat: expose daemon default run configuration"
```

### Task 3: Add Core current-turn separation for Session history prefixes

**Files:**

- Modify: `packages/core/src/run-controller-ports.ts`
- Create: `packages/core/src/run-controller-history.ts`
- Modify: `packages/core/src/run-controller.ts`
- Test: `packages/core/test/run-controller-history.test.ts`
- Test: one existing RunController integration test for retry/repair/recovery behavior

**Interfaces:**

- Consumes: `LLMMessage`, the durable Run conversation snapshot, and the existing `AgentLoop.run()` / `resumeWithToolResults()` inputs.
- Produces: `RunExecutionConfig.historyPrefix?: readonly LLMMessage[]` and `buildRunExecutionHistory(input)`:

```ts
export function buildRunExecutionHistory(input: {
  readonly historyPrefix?: readonly LLMMessage[];
  readonly durableConversation: readonly LLMMessage[];
  readonly mode: "RUN" | "RESUME_WITH_TOOL_RESULTS";
}): readonly LLMMessage[];
```

- [ ] **Step 1: Write deterministic red tests for the pure history helper.**

Use one prior user/assistant pair and a current Run user/assistant-tool-call/tool-result group. Assert that fresh mode returns `prefix + messages before the last user`, resume mode returns `prefix + the full durable conversation`, and neither input array changes:

```ts
const prefix = [
  { role: "user", content: "first goal" },
  { role: "assistant", content: "first verified result" },
] as const;
const durable = [
  { role: "user", content: "current goal" },
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "a.txt" } },
    ],
  },
  { role: "tool", toolCallId: "call-1", content: "ok" },
] as const;

expect(
  buildRunExecutionHistory({ historyPrefix: prefix, durableConversation: durable, mode: "RUN" }),
).toEqual(prefix);
expect(
  buildRunExecutionHistory({
    historyPrefix: prefix,
    durableConversation: durable,
    mode: "RESUME_WITH_TOOL_RESULTS",
  }),
).toEqual([...prefix, ...durable]);
```

- [ ] **Step 2: Run the helper tests and observe the failure.**

Run:

```powershell
pnpm exec vitest run packages/core/test/run-controller-history.test.ts --reporter=dot
```

Expected: FAIL because the helper and `historyPrefix` contract are not implemented.

- [ ] **Step 3: Implement the minimal pure helper.**

For fresh mode, scan backwards for the last `role === "user"`, slice the durable array before that index, and return a new array containing the prefix followed by that slice. For resume mode, return a new array containing the prefix followed by all durable messages. Never mutate or validate provider-specific data in this helper.

- [ ] **Step 4: Wire the helper into `RunController.executeLoop()`.**

Resolve the config as before, then pass:

```ts
const history = buildRunExecutionHistory({
  historyPrefix: config.historyPrefix,
  durableConversation: snapshot.conversation.map((entry) => entry.message),
  mode: resume ? "RESUME_WITH_TOOL_RESULTS" : "RUN",
});
```

Use `history` in the existing AgentLoop input. Keep `resumeWithToolResults()`’s pending decision/tool result handling unchanged. Do not append `historyPrefix` to `messagesToAppend` or any Storage row.

- [ ] **Step 5: Add regression assertions for retry, recover, and repair.**

Extend the existing fake AgentLoop or LLM capture fixture so each fresh execution records its received `history`; assert the prior prefix appears once, the current user goal is not supplied as a second history entry, and a Tool continuation receives the current open turn once. Assert the persisted Conversation remains only the current Run messages.

- [ ] **Step 6: Run focused tests, format, typecheck, and commit.**

Run:

```powershell
pnpm exec vitest run packages/core/test/run-controller-history.test.ts packages/core/test/run-controller*.test.ts --reporter=dot --testTimeout=30000 --maxWorkers=1
pnpm exec prettier --write packages/core/src/run-controller-ports.ts packages/core/src/run-controller-history.ts packages/core/src/run-controller.ts packages/core/test/run-controller-history.test.ts
pnpm typecheck
git add packages/core
git commit -m "feat: preserve current run turn around history prefixes"
```

### Task 4: Implement daemon-owned verified Session conversation context

**Files:**

- Create: `apps/daemon/src/services/session-conversation-context.ts`
- Modify: `apps/daemon/src/daemon-composition.ts`
- Modify: `apps/daemon/src/index.ts`
- Test: `apps/daemon/test/session-conversation-context.test.ts`
- Test: `apps/daemon/test/daemon-production-e2e.test.ts`

**Interfaces:**

- Consumes: `RunRepository.listBySession()`, `AgentRun`, `VerifiedRunFinalResultSchema`, and Core’s `RunExecutionConfigResolver`.
- Produces: `MAX_SESSION_HISTORY_RUNS = 100`, `SessionConversationContextProvider`, and `getHistoryPrefix(currentRun)` returning `readonly LLMMessage[]`.

- [ ] **Step 1: Write failing provider tests for eligibility, order, and bounds.**

Use fake Runs with the same Session/workspace and include completed verified, failed, cancelled, timed-out, max-step, budget-exceeded, invalid-final-result, different-session, different-workspace, and `finishedAt > current.createdAt` candidates. Include equal `createdAt` values with IDs that sort differently. Assert the result is chronological `{goal, finalResult.text}` pairs and contains only the newest 100 eligible Runs.

```ts
const history = await provider.getHistoryPrefix(currentRun);
expect(history).toEqual([
  { role: "user", content: "older eligible goal" },
  { role: "assistant", content: "older verified answer" },
  { role: "user", content: "newer eligible goal" },
  { role: "assistant", content: "newer verified answer" },
]);
expect(history.some((message) => message.role === "tool")).toBe(false);
```

- [ ] **Step 2: Run the provider test to confirm it fails.**

Run:

```powershell
pnpm exec vitest run apps/daemon/test/session-conversation-context.test.ts --reporter=dot
```

Expected: FAIL because the daemon history provider does not exist.

- [ ] **Step 3: Implement fail-closed selection and projection.**

Query the current Session’s Runs through the repository, filter exact Session/workspace identity, `COMPLETED`, valid `finishedAt <= current.createdAt`, and `VerifiedRunFinalResultSchema.safeParse(run.finalResult).success`. Sort by `createdAt ASC`, then `id ASC`, take the newest suffix of at most 100 eligible Runs, and project each Run to exactly one user message followed by one assistant message. Do not read `ConversationRepository`, Tool repositories, event data, or provider data.

- [ ] **Step 4: Wrap the daemon execution config resolver.**

Create one provider in `composeDaemon()`. The effective resolver must preserve every custom resolver field and inject the provider prefix when the resolver did not explicitly supply one:

```ts
const baseResolver = options.configResolver ?? defaultResolver;
const executionConfigResolver = {
  resolve: async (run: AgentRun) => {
    const config = await baseResolver.resolve(run);
    if (config.historyPrefix !== undefined) return config;
    return { ...config, historyPrefix: await historyContext.getHistoryPrefix(run) };
  },
} satisfies RunExecutionConfigResolver;
```

Pass this resolver to `RunController`; no Core package imports Storage.

- [ ] **Step 5: Add a two-turn daemon integration red test.**

Compose the real daemon with file-backed SQLite and a deterministic provider. The provider must capture the second request and assert it includes exactly the first Run goal and verified final text before the second current user goal. Assert both Runs share one Session ID and workspace identity, have distinct Run IDs, and the second Run’s durable Conversation does not contain the first Run messages.

- [ ] **Step 6: Implement the integration fixture and run focused tests.**

Use the existing `startDaemon()`/`CaelushClient` test fixture style, a provider that returns a deterministic final candidate for each turn, and the existing Verification/Completion path. Run:

```powershell
pnpm exec vitest run apps/daemon/test/session-conversation-context.test.ts apps/daemon/test/daemon-production-e2e.test.ts --reporter=dot --testTimeout=30000 --maxWorkers=1
```

Expected: PASS with one Session, two distinct Runs, and the second provider request seeing only the bounded verified history plus its current goal.

- [ ] **Step 7: Export, format, typecheck, and commit.**

Export only the provider constant/class needed by same-package tests and diagnostics from `apps/daemon/src/index.ts`; keep repository and runtime types internal to the daemon implementation. Run targeted Prettier, `pnpm typecheck`, then commit:

```powershell
git add apps/daemon
git commit -m "feat: derive verified session conversation history"
```

### Task 5: Scaffold the CLI package and testable application state

**Files:**

- Modify: `apps/cli/package.json`
- Modify: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/application/cli-state.ts`
- Create: `apps/cli/src/application/event-projector.ts`
- Create: `apps/cli/src/bootstrap/daemon-client.ts`
- Create: `apps/cli/src/bootstrap/safe-errors.ts`
- Test: `apps/cli/test/application-state.test.ts`
- Test: `apps/cli/test/event-projector.test.ts`
- Test: `apps/cli/test/architecture.test.ts`

**Interfaces:**

- Consumes: public client/protocol types only.
- Produces: `CliViewState`, `createInitialCliState()`, `projectAgentEvent()`, `createDaemonClient()`, bounded safe-error mapping, and pinned React/Ink dependencies.

- [ ] **Step 1: Add dependencies and compiler settings without UI code.**

Add runtime dependencies `@caelush/client`, `@caelush/protocol`, `ink@7.1.1`, `ink-text-input@6.0.0`, and `react@19.2.8`; add dev dependencies `@types/react@19.2.18` and `ink-testing-library@4.0.0`. Add `start: node dist/index.js`, `jsx: react-jsx`, and React types to the CLI compiler configuration. Run `pnpm install` to update the lockfile.

- [ ] **Step 2: Write red state and event projection tests.**

Assert that the initial state is `STARTING`, valid matching `status.changed` events map to `Preparing`, `Working`, `Retrying`, `Verifying`, and `Approval required`, terminal events are marked terminal, valid Tool/file/process/reasoning events leave transcript and public details unchanged, and an event for another Run is ignored.

```ts
const projected = projectAgentEvent(
  { ...readyState, activeRun: { runId, status: "RUNNING" } },
  event,
);
expect(projected.state.activeRun).toEqual({ runId, status: "VERIFYING" });
expect(projected.state.transcript).toEqual([]);
expect(projected.terminal).toBe(false);
```

- [ ] **Step 3: Run focused tests to observe missing modules.**

Run:

```powershell
pnpm exec vitest run apps/cli/test/application-state.test.ts apps/cli/test/event-projector.test.ts --reporter=dot
```

Expected: FAIL because the state and projector modules are not present.

- [ ] **Step 4: Implement allowlisted immutable view state and event projection.**

Keep transcript entries to `{id, kind: "USER" | "ASSISTANT" | "RUN_TERMINAL", text, runId?}`. Keep active state to `{runId, status}` and use a finite activity string. Map `run.started`, `status.changed`, LLM/retry/verification/approval events to safe labels; ignore all valid detailed Tool/file/process/reasoning payloads. Never copy event payload text into transcript.

- [ ] **Step 5: Implement safe daemon client construction.**

Use `CAELUSH_DAEMON_URL` when it is a non-empty string, otherwise `http://127.0.0.1:43120`, and return `new CaelushClient({ baseUrl })`. Keep environment access in the CLI bootstrap layer; no direct `fetch` or HTTP path literals are allowed in application/controller code.

- [ ] **Step 6: Implement bounded safe-error mapping and architecture guards.**

Map fetch/unreachable failures to `Caelush Local Agent Service is not reachable.`, protocol/compatibility failures to `Daemon protocol compatibility check failed.`, and unknown failures to `Caelush could not complete the requested operation.`. Add an architecture test that scans `apps/cli/src` and fails if it finds imports of forbidden packages, `node:fs`, `spawn`, `git`, direct `fetch`, provider/Tool payload terms, or later-phase UI modules.

- [ ] **Step 7: Format, typecheck, and commit the CLI scaffold.**

Run:

```powershell
pnpm exec prettier --write apps/cli/package.json apps/cli/tsconfig.json apps/cli/src/application/cli-state.ts apps/cli/src/application/event-projector.ts apps/cli/src/bootstrap/daemon-client.ts apps/cli/src/bootstrap/safe-errors.ts apps/cli/test/application-state.test.ts apps/cli/test/event-projector.test.ts apps/cli/test/architecture.test.ts
pnpm typecheck
pnpm exec vitest run apps/cli/test/application-state.test.ts apps/cli/test/event-projector.test.ts apps/cli/test/architecture.test.ts --reporter=dot
git add apps/cli pnpm-lock.yaml
git commit -m "feat: scaffold cli application state"
```

### Task 6: Implement the CLI conversation controller and durable lifecycle

**Files:**

- Create: `apps/cli/src/application/cli-controller.ts`
- Modify: `apps/cli/src/application/cli-state.ts`
- Test: `apps/cli/test/cli-controller.test.ts`
- Test: `apps/cli/test/cli-controller-terminal.test.ts`

**Interfaces:**

- Consumes: a narrow injected `CliClient` interface with `getHealth`, `getInfo`, `createSession`, `createRun`, `watchRunEvents`, `startRun`, and `getRun`.
- Produces: `CliConversationController` with `getState()`, `subscribe(listener)`, `bootstrap()`, `submitPrompt(prompt)`, and `dispose()`.

- [ ] **Step 1: Write failing bootstrap tests.**

Fake the narrow client and assert `bootstrap()` calls `getHealth()` before `getInfo()`, creates exactly one Session with the normalized current workspace, basename title, `defaultModel`, and empty metadata, reaches `READY`, and leaves the composer disabled with no Session when defaults are missing or the daemon is unreachable.

- [ ] **Step 2: Write failing submission and race tests.**

Assert the sequence `optimistic USER entry → createRun → watchRunEvents → startRun`, verbatim use of `defaultRunConfiguration`, distinct Run creation only after the prior active Run settles, and rejection/ignore of a rapid second `submitPrompt()` while the first request is in flight or active. Assert empty/whitespace input is ignored and UTF-8 prompts above the bounded input limit are rejected safely.

- [ ] **Step 3: Run controller tests to observe the failure.**

Run:

```powershell
pnpm exec vitest run apps/cli/test/cli-controller.test.ts apps/cli/test/cli-controller-terminal.test.ts --reporter=dot
```

Expected: FAIL because the controller and lifecycle methods are not implemented.

- [ ] **Step 4: Implement bootstrap and one-Session ownership.**

Track one normalized workspace `{ id: createWorkspaceId(), path: resolve(workspacePath) }`, call health/info once, require both `defaultModel` and `defaultRunConfiguration`, then call `createSession()` once. Set a sanitized `BOOTSTRAP_ERROR` state on failure and never create a Session from an incomplete configuration.

- [ ] **Step 5: Implement the guarded submit sequence.**

Set a synchronous `submissionInFlight` guard before the first await, append an optimistic public user entry, call `createRun()` with the Session ID, current workspace, selected default model, and exact daemon defaults, bind the returned Run ID, then start the event iterator before `startRun()`. Keep `activeRun` and `composerEnabled` false/disabled until canonical terminal settlement.

- [ ] **Step 6: Implement SSE projection and terminal settlement.**

Consume `watchRunEvents()` with an `AbortController`, pass each valid event through `projectAgentEvent()`, ignore mismatched Run IDs, and use a per-active-Run settlement guard. On the first terminal event call `getRun(runId)` exactly once. For `COMPLETED`, parse `run.finalResult` with `VerifiedRunFinalResultSchema` and append only `.text`; if invalid, append a safe terminal error. For other terminal statuses append one safe `RUN_TERMINAL` entry without an assistant answer. Abort the stream and re-enable the composer after settlement.

- [ ] **Step 7: Implement stream failure and disposal semantics.**

On an un-aborted stream failure, set a transport-error activity, do not call `cancelRun()`, do not manufacture `FAILED`, and keep the active Run/composer lock because 12B has no reconnect path. `dispose()` aborts the active stream, prevents later state publication, and does not cancel the daemon Run.

- [ ] **Step 8: Run focused tests, format, typecheck, and commit.**

Run:

```powershell
pnpm exec vitest run apps/cli/test/cli-controller.test.ts apps/cli/test/cli-controller-terminal.test.ts --reporter=dot --testTimeout=30000 --maxWorkers=1
pnpm exec prettier --write apps/cli/src/application/cli-controller.ts apps/cli/src/application/cli-state.ts apps/cli/test/cli-controller.test.ts apps/cli/test/cli-controller-terminal.test.ts
pnpm typecheck
git add apps/cli
git commit -m "feat: add cli daemon conversation controller"
```

### Task 7: Build the Ink shell and process entry point

**Files:**

- Create: `apps/cli/src/components/App.tsx`
- Create: `apps/cli/src/components/Header.tsx`
- Create: `apps/cli/src/components/Transcript.tsx`
- Create: `apps/cli/src/components/ActivityStatus.tsx`
- Create: `apps/cli/src/components/Composer.tsx`
- Create: `apps/cli/src/components/FatalError.tsx`
- Create: `apps/cli/src/main.tsx`
- Modify: `apps/cli/src/index.ts`
- Test: `apps/cli/test/components.test.tsx`
- Test: `apps/cli/test/main-lifecycle.test.ts`

**Interfaces:**

- Consumes: `CliViewState`, `CliConversationController`, React 19, Ink 7, and `ink-text-input`.
- Produces: a real Ink app with a primary `<Static>` transcript region, dynamic header/activity/composer, and a clean `main()` process entry.

- [ ] **Step 1: Write failing component tests with Ink render helpers.**

Render controlled state fixtures for Connecting, Ready, Working, Retrying, Verifying, Approval required, Completed, Failed, and fatal states. Assert allowlisted user-visible text, bounded project path, model/provider, no Tool IDs/stdout/patch/reasoning, static transcript entries, Unicode/Chinese/emoji rendering, disabled composer, and ignored whitespace submission.

```tsx
const rendered = render(<App controller={fakeController} />);
expect(rendered.lastFrame()).toContain("Caelush");
expect(rendered.lastFrame()).toContain("Ready");
expect(rendered.lastFrame()).not.toContain("toolCallId");
```

- [ ] **Step 2: Run the UI tests to observe missing components.**

Run:

```powershell
pnpm exec vitest run apps/cli/test/components.test.tsx --reporter=dot
```

Expected: FAIL because the component tree and process entry are not present.

- [ ] **Step 3: Implement the thin Ink component tree.**

Use `<Static items={state.transcript}>` for settled entries and keep Header, ActivityStatus, and Composer outside Static so they can update. Use `TextInput` with controlled value, `focus={state.composerEnabled}`, `onChange`, and `onSubmit`; clear the input only after the controller accepts a prompt. Use plain text wrapping and a fixed bounded display truncation for long paths.

- [ ] **Step 4: Implement process lifecycle and exit behavior.**

`main()` creates the client from the bootstrap module, constructs one controller for `process.cwd()`, starts `bootstrap()` before/while rendering, awaits Ink’s `waitUntilExit()`, then calls `dispose()`. Ctrl+C/Ctrl+D exits with code 0 when no Run is active; with an active Run it exits locally without cancellation and emits a safe daemon-continuation message. Bootstrap errors render once and set exit code 1. No daemon auto-start, reconnect, cancel, resume, packaging, or alternate-screen behavior is added.

- [ ] **Step 5: Add entrypoint safety and component checks.**

Keep `apps/cli/src/index.ts` side-effect-free when imported by tests and invoke `main()` only when it is the executable module. Test that `main()` disposes the controller after Ink exits and that fatal bootstrap state returns exit code 1 without creating a Session.

- [ ] **Step 6: Format, typecheck, build CLI, and commit.**

Run:

```powershell
pnpm exec prettier --write apps/cli/src/components apps/cli/src/main.tsx apps/cli/src/index.ts apps/cli/test/components.test.tsx apps/cli/test/main-lifecycle.test.ts
pnpm exec vitest run apps/cli/test/components.test.tsx apps/cli/test/main-lifecycle.test.ts --reporter=dot --testTimeout=30000 --maxWorkers=1
pnpm typecheck
pnpm --filter @caelush/cli build
git add apps/cli
git commit -m "feat: add ink cli application shell"
```

### Task 8: Add architecture documentation and repository status updates

**Files:**

- Create: `docs/architecture/cli-application-shell.md`
- Create: `docs/architecture/session-conversation-lifecycle.md`
- Modify: `docs/architecture/client-transport.md`
- Modify: `docs/architecture/daemon-production-composition.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Test: `apps/cli/test/architecture.test.ts`

**Interfaces:**

- Consumes: implemented CLI/controller/history behavior and the Phase 12B design spec.
- Produces: durable architecture records stating ownership, data-flow, bounds, error behavior, and explicit Phase 12B completion scope.

- [ ] **Step 1: Write documentation assertions before editing prose.**

Extend the architecture guard to require the docs to mention: one Session per CLI process, one Run per prompt, verified-only chronological history, `finishedAt <= currentRun.createdAt`, 100-Run bound, Core `historyPrefix`, `<Static>` transcript, existing typed client, no direct HTTP, no auto-reconnect, and safe terminal final-result parsing.

- [ ] **Step 2: Run the guard and observe missing documentation.**

Run:

```powershell
pnpm exec vitest run apps/cli/test/architecture.test.ts --reporter=dot
```

Expected: FAIL for the newly required architecture records.

- [ ] **Step 3: Write the four architecture documents and status updates.**

Document the actual file/module ownership and call sequences. Update `README.md` and `AGENTS.md` to mark Phase 12B as the current completed boundary only after implementation verification, while retaining all existing Phase 8/11 and daemon/Core constraints.

- [ ] **Step 4: Run documentation guard and targeted formatting.**

Run:

```powershell
pnpm exec vitest run apps/cli/test/architecture.test.ts --reporter=dot
pnpm exec prettier --write docs/architecture/cli-application-shell.md docs/architecture/session-conversation-lifecycle.md docs/architecture/client-transport.md docs/architecture/daemon-production-composition.md README.md AGENTS.md
git add docs README.md AGENTS.md
git commit -m "docs: record phase 12b cli and conversation architecture"
```

### Task 9: Execute full verification and completion gates

**Files:**

- Inspect: every changed file from `git diff --name-only origin/master...HEAD`
- Test: all workspace tests and all Phase 12B focused tests

**Interfaces:**

- Consumes: all implementation tasks and their focused commits.
- Produces: evidence that the branch is buildable, typed, tested, formatted without new warnings, architecturally scoped, and ready for the requested remote delivery.

- [ ] **Step 1: Run changed-file formatting check and inspect the diff.**

Run:

```powershell
$files = git diff --name-only origin/master...HEAD | Where-Object { Test-Path $_ }
pnpm exec prettier --check $files
git diff --check
git diff --stat origin/master...HEAD
git diff --name-only origin/master...HEAD
```

Expected: every changed text file is formatted, `git diff --check` is clean, and no generated or unrelated file is included.

- [ ] **Step 2: Run the repository verification commands.**

Run exactly:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm check
```

Expected: lint, typecheck, tests, build, and check pass. The pre-existing global format-warning count may remain 724, but changed files must add no warnings. If Windows parallel tests reproduce the documented baseline contention, rerun the affected files serially at 30 seconds, investigate with the systematic-debugging skill, and do not hide the issue by changing global timeouts.

- [ ] **Step 3: Verify scope and public-safety invariants.**

Run:

```powershell
rg -n "@caelush/(core|storage|runtime|security|tools|context|verification|llm)|node:fs|spawn\(|fetch\(|toolCallId|stdout|stderr|reasoning|patch" apps/cli/src
rg -n "12C|12D|12E|timeline|reconnect|resume|cancelRun|resolveApproval|auto.?start" apps/cli/src
```

Expected: forbidden architecture imports/capabilities are absent from CLI source; later-round UX and durable mutation paths are not implemented.

- [ ] **Step 4: Inspect final status, commit any verification-only corrections, and record the final SHA.**

Run:

```powershell
git status --short
git log --oneline --decorate -n 12
git rev-parse HEAD
```

Expected: the worktree is clean and the final commit SHA is recorded for delivery.

- [ ] **Step 5: Push only the requested Phase 12B branch and verify the remote SHA.**

Run:

```powershell
git push -u origin codex/phase-12b-cli-shell-conversation-lifecycle
git ls-remote origin refs/heads/codex/phase-12b-cli-shell-conversation-lifecycle
```

Expected: the remote branch resolves to the locally verified final SHA. Do not force-push, rewrite history, or create a PR unless separately requested.

## Plan self-review checklist

- Protocol defaults, Core prefix flow, daemon eligibility, CLI controller, Ink rendering, tests, architecture guards, documentation, and final verification each have a concrete task.
- Every implementation task has a red test, a focused command, a minimal implementation boundary, and a commit checkpoint.
- The helper signature and state/controller names are consistent across tasks.
- The plan does not create a Storage history table, a second Core loop, a CLI HTTP layer, a Tool timeline, or later-phase cancellation/reconnect/resume behavior.
- The plan preserves the user-provided document as the scope authority while treating repository/AGENTS.md instructions as implementation constraints.
