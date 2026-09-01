# Caelush Phase 12D — Interactive Control, Session Resume & Transport Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Phase 12C CLI so users can safely approve or reject durable Tool requests, cancel or detach active Runs, resume exact or latest Sessions, recover non-terminal Runs, and reconnect interrupted SSE streams without changing daemon-owned authority or public RunStatus.

**Architecture:** Keep `CliConversationController` as the single CLI application coordinator and keep React components presentation-only. Add pure, independently tested modules for launch parsing, Session/workspace/transcript policy, control routing, and deterministic reconnect scheduling; extend the existing Client SSE iterator additively with `onOpen`; reuse the existing Timeline reducer and daemon control APIs.

**Tech Stack:** TypeScript ESM, Node.js 24, pnpm workspace, React 19, Ink 7, ink-testing-library, Vitest, `@caelush/client`, `@caelush/protocol`, Fastify daemon fixtures, SQLite-backed daemon composition.

**Spec:** `docs/superpowers/specs/2026-09-01-caelush-phase-12d-interactive-control-session-recovery-design.md`

## Global Constraints

- Phase 12D owns CLI control-plane interaction and durable Session/transport recovery only; Phase 12E remains untouched.
- The CLI may depend on `@caelush/client`, `@caelush/protocol`, React and Ink; it must not depend on Core, Storage, Runtime, Security, Tools, Verification or LLM.
- The CLI must never directly access SQLite, filesystem project discovery, shell, Git, daemon internals or repository rows.
- Approval, cancellation, recovery, Run status and Tool execution authority remain daemon/Core-owned; the CLI submits typed requests and reconciles canonical responses/events.
- Do not add `CANCELLING`, `RECONNECTING` or `RESUMING` to protocol `RunStatus`.
- Reuse the existing `timeline-reducer.ts`; durable sequence is the reconnect cursor, and ephemeral events never advance it.
- Resume must preserve the selected Session ID and complete WorkspaceRef ID/path; never create a replacement WorkspaceRef for an existing Session.
- New Runs in resumed Sessions use the Session model when available and the current daemon `defaultRunConfiguration`; historical Run permissions/limits never carry forward.
- Historical transcript contains only Run goals, verified final assistant text, and safe terminal notices; no raw Tool/Provider/Continuation internals.
- Approval UI must display only allowlisted safe fields and exact `approval.id`; no raw action JSON, arguments, commands, patches, stdin, approval keys, credentials or provider payloads.
- Approval default selection is Reject; ONCE requests hide the Run-scope option; Run-scope copy must say “Approve this action for this Run”.
- Ctrl+C is `cancelRun`, never a new Prompt; Ctrl+D detaches/exits without cancellation.
- Cancellation and terminal SSE paths share exactly-once terminal settlement; `SETTLED` is not interpreted as `CANCELLED`.
- Reconnect delays are exactly 250ms, 500ms, 1000ms, 2000ms, 4000ms, 5000ms, with no jitter and no unbounded retry.
- No React component owns an HTTP call, repository policy, recovery decision, timer, or reconnect generation.
- New/changed files must be formatted with zero Prettier warnings; total repository warning count must not exceed the measured baseline of 773. Do not run `prettier --write .`.
- Every production behavior change follows RED → GREEN → REFACTOR, with the failing test observed before implementation.

---

## Task 1: Add the typed LaunchIntent parser and main entry handling

**Files:**

- Create: `apps/cli/src/bootstrap/cli-args.ts`
- Test: `apps/cli/test/cli-args.test.ts`
- Modify: `apps/cli/src/main.tsx`
- Modify: `apps/cli/src/index.ts`
- Test: `apps/cli/test/main-lifecycle.test.ts`

**Interfaces:**

- Produces `LaunchIntent`, `CliArgsError`, and `parseCliArgs(argv: readonly string[]): LaunchIntent`.
- `LaunchIntent` is exactly `{ kind: "NEW" }`, `{ kind: "CONTINUE" }`, `{ kind: "RESUME_PICKER" }`, or `{ kind: "RESUME_EXACT"; sessionId: SessionId }`.
- `main()` accepts an optional `argv?: readonly string[]` test seam, parses before creating React, and returns exit code 1 after a safe invalid-argument message without creating a Session or Run.

- [ ] **Step 1: Write the failing parser tests**

```ts
it.each([
  [[], { kind: "NEW" }],
  [["-c"], { kind: "CONTINUE" }],
  [["--continue"], { kind: "CONTINUE" }],
  [["-r"], { kind: "RESUME_PICKER" }],
  [["--resume"], { kind: "RESUME_PICKER" }],
])("parses %j", (argv, expected) => {
  expect(parseCliArgs(argv)).toEqual(expected);
});

it("parses an exact Session ID and rejects conflicts, unknown flags, and extra values", () => {
  const sessionId = createSessionId();
  expect(parseCliArgs(["--resume", sessionId])).toEqual({
    kind: "RESUME_EXACT",
    sessionId,
  });
  expect(() => parseCliArgs(["--continue", "--resume"])).toThrow(CliArgsError);
  expect(() => parseCliArgs(["-r", sessionId, sessionId])).toThrow(CliArgsError);
  expect(() => parseCliArgs(["--unknown"])).toThrow(CliArgsError);
  expect(() => parseCliArgs(["--resume", "not-a-session"])).toThrow(CliArgsError);
});
```

- [ ] **Step 2: Run the focused parser test and observe the missing parser failure**

Run: `pnpm exec vitest run apps/cli/test/cli-args.test.ts`

Expected: FAIL because `cli-args.ts` and `parseCliArgs` do not exist.

- [ ] **Step 3: Implement the minimum pure parser**

Use `SessionIdSchema.safeParse` for the exact value, reject every token not in the four accepted forms, and never read `process.argv` inside the parser. Add `argv` to `CliMainOptions`; use `options.argv ?? process.argv.slice(2)`, catch `CliArgsError`, write only its safe message through the existing lifecycle seam, and return 1 before constructing the controller/application.

- [ ] **Step 4: Run parser and main lifecycle tests**

Run: `pnpm exec vitest run apps/cli/test/cli-args.test.ts apps/cli/test/main-lifecycle.test.ts`

Expected: PASS, including no Client calls for malformed arguments.

- [ ] **Step 5: Commit the parser boundary**

```bash
git add apps/cli/src/bootstrap/cli-args.ts apps/cli/src/main.tsx apps/cli/src/index.ts apps/cli/test/cli-args.test.ts apps/cli/test/main-lifecycle.test.ts
git commit -m "feat(cli): add typed launch intents"
```

## Task 2: Implement pure Session candidate, workspace and transcript policies

**Files:**

- Create: `apps/cli/src/application/session-resume.ts`
- Test: `apps/cli/test/session-resume.test.ts`
- Modify: `apps/cli/src/application/cli-controller.ts` only to consume exported helpers in Task 6.

**Interfaces:**

- Produces `MAX_SESSION_CANDIDATES = 100`, `SESSION_ENRICH_CONCURRENCY = 8`, `CliSessionCandidate`, `sortSessionCandidates`, `deriveSessionActivity`, `resolveSessionWorkspace`, `hydrateSessionTranscript`, `nonTerminalRuns`, and `normalizeWorkspacePath`.
- `resolveSessionWorkspace(session, visibleRuns, currentWorkspacePath)` returns either `{ workspace: WorkspaceRef }` or `{ error: string }` and preserves an existing `defaultWorkspace` exactly.
- `hydrateSessionTranscript(runs, activeRunId?)` returns immutable `CliTranscriptEntry[]` in `createdAt ASC, id ASC` order and does not include raw Tool data.
- `listMatchingSessionCandidates(client, workspacePath)` uses `listSessions({ limit: 100 })`, `listRuns(sessionId, { limit: 1 })`, and a bounded worker pool of eight; it never calls `createSession`.

- [ ] **Step 1: Write failing policy tests**

```ts
it("sorts candidates by derived activity and Session ID tie-break", () => {
  const candidates = [candidate("sess_b", 10), candidate("sess_a", 10), candidate("sess_c", 9)];
  expect(sortSessionCandidates(candidates).map((item) => item.session.id)).toEqual([
    "sess_a",
    "sess_b",
    "sess_c",
  ]);
});

it("reuses the exact stored WorkspaceRef and fails on another path", () => {
  const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
  const session = makeSession({ defaultWorkspace: workspace });
  expect(resolveSessionWorkspace(session, [], "C:\\workspace\\project")).toEqual({ workspace });
  expect(resolveSessionWorkspace(session, [], "C:\\other")).toEqual({
    error: "This Session belongs to another workspace. Start Caelush from that workspace to resume it.",
  });
});

it("hydrates only public chronological transcript and includes an active goal once", () => {
  const runs = [completedVerifiedRun("second", "answer 2", 2), failedRun("first", 1), activeRun("active", 3)];
  expect(hydrateSessionTranscript(runs, runs[2]!.id)).toMatchObject([
    { kind: "USER", text: "first" },
    { kind: "RUN_TERMINAL" },
    { kind: "USER", text: "second" },
    { kind: "ASSISTANT", text: "answer 2" },
    { kind: "USER", text: "active" },
  ]);
});
```

- [ ] **Step 2: Run the policy test and confirm it fails for missing exports**

Run: `pnpm exec vitest run apps/cli/test/session-resume.test.ts`

Expected: FAIL because the policy module is absent.

- [ ] **Step 3: Implement bounded candidate enrichment and workspace policy**

Normalize with `resolve()` and platform-safe separator/case comparison; keep the original stored path in the returned WorkspaceRef. Use a queue of at most eight in-flight `listRuns` calls. Filter candidates to the current workspace before sorting. For legacy sessions, inspect up to the bounded visible Run list and accept only exactly one distinct `(workspace.id, normalized workspace.path)` pair; otherwise return the specified ambiguity error.

- [ ] **Step 4: Implement transcript hydration**

Sort Runs by numeric `createdAt`, then ID. Emit each goal once. Parse `finalResult` with `VerifiedRunFinalResultSchema`; emit verified assistant text only for COMPLETED Runs. Emit a safe terminal status entry for FAILED, CANCELLED, TIMEOUT, MAX_STEPS_REACHED and BUDGET_EXCEEDED; use the invalid-final-result notice for malformed COMPLETED results. Do not copy any Run object or internal fields into transcript state.

- [ ] **Step 5: Run the policy tests green and commit**

Run: `pnpm exec vitest run apps/cli/test/session-resume.test.ts`

Expected: PASS with workspace ID/path reuse, legacy ambiguity rejection, candidate bound, deterministic ordering and transcript privacy covered.

```bash
git add apps/cli/src/application/session-resume.ts apps/cli/test/session-resume.test.ts
git commit -m "feat(cli): add session resume policies"
```

## Task 3: Add explicit CLI control, Approval and transport state models

**Files:**

- Create: `apps/cli/src/application/cli-control.ts`
- Modify: `apps/cli/src/application/cli-state.ts`
- Test: `apps/cli/test/cli-control.test.ts`
- Modify: `apps/cli/test/application-state.test.ts`

**Interfaces:**

- Produces `CliTransportState`, `CliControlMode`, `CliApprovalOption`, `CliApprovalView`, `CliApprovalState`, `createApprovalView`, `approvalOptions`, `approvalResolutionForOption`, `routeCliInput`, and `isTerminalRunStatus`-based control predicates.
- `CliViewState` gains explicit `transportState`, `controlMode`, `approvalState?`, `sessionCandidates`, `recoveryCandidates`, `pendingRunId?`, `notice?`, `controlError?`, and `transportError?`; existing `fatalError` remains for fatal bootstrap/configuration errors only.
- `routeCliInput(state, input, key)` returns a typed action for exactly one highest-priority surface in the order Session Picker, Approval, PENDING confirmation, disconnected controls, active Run controls, composer.

- [ ] **Step 1: Write failing state and routing tests**

```ts
it("starts Approval selection at Reject and hides Run scope for ONCE", () => {
  const once = createApprovalView(makeApproval({ scope: "ONCE" }));
  expect(once.selectedIndex).toBe(once.options.findIndex((item) => item.kind === "REJECT"));
  expect(once.options.some((item) => item.kind === "APPROVE_RUN")).toBe(false);
});

it.each([
  [stateWithApproval(), { input: "\r", key: { return: true } }, "APPROVAL_SUBMIT"],
  [stateWithSessionPicker(), { input: "\r", key: { return: true } }, "SESSION_SELECT"],
  [stateWithActiveRun(), { input: "c", key: { ctrl: true } }, "CANCEL"],
  [stateWithActiveRun(), { input: "d", key: { ctrl: true } }, "DETACH"],
  [stateDisconnected(), { input: "r", key: {} }, "RECONNECT"],
])("routes input to one active surface", (state, key, expected) => {
  expect(routeCliInput(state, key.input, key.key).kind).toBe(expected);
});
```

- [ ] **Step 2: Run the focused tests and observe missing state/action failures**

Run: `pnpm exec vitest run apps/cli/test/cli-control.test.ts apps/cli/test/application-state.test.ts`

Expected: FAIL because the explicit state fields and control helpers do not exist.

- [ ] **Step 3: Implement immutable safe state and Approval view projection**

Use an allowlist for action fields: `toolName`, `requiredCapabilities` string entries, and `summary` string only when bounded; ignore every other action key. Build options from `approval.scope`, map them to the three exact protocol resolution payloads, and initialize selected index to Reject. Add explicit transport/control defaults without changing RunStatus.

- [ ] **Step 4: Implement single-surface input routing**

Check only the highest-priority active mode; `Esc` closes Approval/picker/confirmation without resolving or cancelling, `Enter` submits the active selection, Ctrl+C produces cancel only when an active Run exists, Ctrl+D produces detach only when an active Run exists, and `R` produces manual reconnect only when disconnected.

- [ ] **Step 5: Run tests green and commit**

Run: `pnpm exec vitest run apps/cli/test/cli-control.test.ts apps/cli/test/application-state.test.ts`

Expected: PASS with no raw Approval data in serialized view state.

```bash
git add apps/cli/src/application/cli-control.ts apps/cli/src/application/cli-state.ts apps/cli/test/cli-control.test.ts apps/cli/test/application-state.test.ts
git commit -m "feat(cli): model control and transport state"
```

## Task 4: Add the Client `watchRunEvents` onOpen lifecycle hook

**Files:**

- Modify: `packages/client/src/client.ts`
- Modify: `packages/client/src/index.ts`
- Test: `packages/client/test/client.test.ts`

**Interfaces:**

- `WatchRunEventsOptions` gains optional `onOpen?: () => void`.
- `CaelushClient.watchRunEvents()` invokes `onOpen` once only after `fetch` resolves `response.ok`, `response.body !== null`, and `getReader()` succeeds; it does not invoke it after iterator creation, on HTTP/fetch/protocol error, or after pre-open abort.

- [ ] **Step 1: Add failing onOpen lifecycle tests**

```ts
it("calls onOpen once after a successful response and reader creation", async () => {
  let opens = 0;
  const client = new CaelushClient({
    baseUrl: "http://daemon.test",
    fetch: async () =>
      new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), {
        status: 200,
      }),
  });
  for await (const _event of client.watchRunEvents(createRunId(), { onOpen: () => { opens += 1; } })) {}
  expect(opens).toBe(1);
});

it("does not call onOpen for HTTP, fetch, body, or pre-open abort failures", async () => {
  for (const client of [
    clientReturning(new Response("unavailable", { status: 503 })),
    clientThrowing(new Error("fetch failed")),
    clientReturning(new Response(null, { status: 200 })),
  ]) {
    let opens = 0;
    const iterator = client.watchRunEvents(createRunId(), { onOpen: () => { opens += 1; } });
    await expect(iterator.next()).rejects.toBeInstanceOf(Error);
    expect(opens).toBe(0);
  }
  const abortController = new AbortController();
  abortController.abort();
  let opens = 0;
  const aborted = clientReturning(new Response(new ReadableStream<Uint8Array>(), { status: 200 }));
  await expect(aborted.watchRunEvents(createRunId(), { signal: abortController.signal, onOpen: () => { opens += 1; } }).next()).resolves.toMatchObject({ done: true });
  expect(opens).toBe(0);
});

function clientReturning(response: Response): CaelushClient {
  return new CaelushClient({ baseUrl: "http://daemon.test", fetch: async () => response });
}

function clientThrowing(error: Error): CaelushClient {
  return new CaelushClient({ baseUrl: "http://daemon.test", fetch: async () => { throw error; } });
}
```

- [ ] **Step 2: Run the Client tests and observe the missing callback failure**

Run: `pnpm exec vitest run packages/client/test/client.test.ts`

Expected: FAIL because `WatchRunEventsOptions` has no `onOpen` and the callback is never called.

- [ ] **Step 3: Implement the additive callback at the handshake boundary**

Place `options.onOpen?.()` immediately after body/reader validation and before the first `reader.read()`. Preserve existing abort handling and reader cancellation. Do not expose Response or reader types through the public API.

- [ ] **Step 4: Run all Client tests green and commit**

Run: `pnpm exec vitest run packages/client/test/client.test.ts`

Expected: PASS for old SSE parsing/abort behavior plus all new onOpen cases.

```bash
git add packages/client/src/client.ts packages/client/src/index.ts packages/client/test/client.test.ts
git commit -m "feat(client): expose SSE connection open lifecycle"
```

## Task 5: Implement the injectable deterministic reconnect scheduler

**Files:**

- Create: `apps/cli/src/application/reconnect-scheduler.ts`
- Test: `apps/cli/test/reconnect-scheduler.test.ts`

**Interfaces:**

- Produces `CLI_RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 5000] as const`.
- `CliTimer` is `{ schedule(delayMs: number, callback: () => void): CliTimerHandle }`; `CliTimerHandle` is `{ cancel(): void }`.
- `CliReconnectScheduler` constructor accepts `{ timer: CliTimer; onAttempt(attempt: number): void; onExhausted(): void }`.
- Methods are `start()`, `manualRetry()`, `succeeded()`, `failed()`, and `dispose()`. `failed()` schedules at most the next configured attempt; after the sixth failure it calls `onExhausted` and schedules nothing. `manualRetry()` starts attempt 1 only from exhausted/idle; `succeeded()` cancels pending work and resets attempt state.

- [ ] **Step 1: Write failing scheduler tests**

```ts
it("uses the fixed delay sequence and exhausts after six failed attempts", () => {
  const timer = new FakeTimer();
  const attempts: number[] = [];
  const scheduler = new CliReconnectScheduler({
    timer,
    onAttempt: (attempt) => attempts.push(attempt),
    onExhausted: () => attempts.push(99),
  });
  scheduler.start();
  for (let i = 0; i < 6; i += 1) {
    timer.runNext();
    scheduler.failed();
  }
  expect(timer.delays).toEqual([250, 500, 1000, 2000, 4000, 5000]);
  expect(attempts).toContain(99);
});

it("cancels timers on success, manual retry, and dispose", () => {
  // Assert one pending timer, cancellation, attempt reset and no callback after dispose.
});
```

- [ ] **Step 2: Run scheduler tests and observe the missing module failure**

Run: `pnpm exec vitest run apps/cli/test/reconnect-scheduler.test.ts`

Expected: FAIL because the scheduler module is absent.

- [ ] **Step 3: Implement the minimal timer-driven scheduler**

Keep all timers behind `CliTimer`; store one pending handle and one attempt counter; never call `setTimeout` from a reducer or React component. Make repeated `start()` idempotent while an attempt is pending and make every callback check the disposed flag.

- [ ] **Step 4: Run scheduler tests green and commit**

Run: `pnpm exec vitest run apps/cli/test/reconnect-scheduler.test.ts`

Expected: PASS for delays, exhaustion, reset and disposal.

```bash
git add apps/cli/src/application/reconnect-scheduler.ts apps/cli/test/reconnect-scheduler.test.ts
git commit -m "feat(cli): add bounded SSE reconnect scheduler"
```

## Task 6: Extend `CliConversationController` with launch modes, resume and hydration

**Files:**

- Modify: `apps/cli/src/application/cli-controller.ts`
- Modify: `apps/cli/src/application/cli-state.ts`
- Modify: `apps/cli/src/main.tsx`
- Modify: `apps/cli/test/cli-controller.test.ts`
- Modify: `apps/cli/test/cli-controller-terminal.test.ts`
- Modify: `apps/cli/test/main-lifecycle.test.ts`
- Modify: `apps/cli/test/application-state.test.ts`

**Interfaces:**

- `CliConversationControllerOptions` gains `launchIntent?: LaunchIntent`; default is `{ kind: "NEW" }`.
- `CliDaemonClient` gains required typed methods `listSessions`, `getSession`, `listRuns`, `recoverRun`, `cancelRun`, `listPendingApprovals`, and `resolveApproval`, matching `@caelush/client` signatures and preserving `WatchRunEventsOptions`.
- Controller bootstrap follows `health → info → launch policy`; only `NEW` calls `createSession`.
- Controller public methods produced for later tasks are `selectSession(index)`, `selectRecoveryRun(index)`, `confirmPendingRun(start: boolean)`, `resolveApproval(approvalId, resolution)`, `cancelActiveRun()`, `detachActiveRun()`, `reconnectActiveRun()`, and `dispose()`.

- [ ] **Step 1: Add failing bootstrap/resume tests**

```ts
it("uses --continue to select the latest current-workspace Session without creating one", async () => {
  const client = makeClient({ listSessions: async () => ({ items: [sessionWithWorkspace()] }), listRuns: async () => ({ items: [completedRun()] }) });
  const controller = new CliConversationController({ client, workspacePath: "C:\\workspace\\project", launchIntent: { kind: "CONTINUE" } });
  await controller.bootstrap();
  expect(client.createSession).not.toHaveBeenCalled();
  expect(controller.getState().session?.id).toBeDefined();
});

it("resumes the exact WorkspaceRef identity and applies current daemon security defaults to a new Run", async () => {
  const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
  const session = sessionWithWorkspace(workspace);
  const client = makeClient({ getSession: async () => session, listRuns: async () => ({ items: [] }) });
  const controller = new CliConversationController({ client, workspacePath: workspace.path, launchIntent: { kind: "RESUME_EXACT", sessionId: session.id } });
  await controller.bootstrap();
  await controller.submitPrompt("new turn");
  expect(client.createRun).toHaveBeenCalledWith(session.id, expect.objectContaining({ workspace }));
});
```

- [ ] **Step 2: Run controller tests and observe missing resume behavior**

Run: `pnpm exec vitest run apps/cli/test/cli-controller.test.ts apps/cli/test/cli-controller-terminal.test.ts`

Expected: FAIL because bootstrap always creates a new Session and the controller has no resume APIs.

- [ ] **Step 3: Update Client test fixtures and add launch-aware bootstrap**

Call health/info first for every intent. For `NEW`, preserve existing behavior and create a new WorkspaceRef. For `CONTINUE`, call bounded candidate enrichment and exact-resume the selected Session. For `RESUME_PICKER`, publish candidate state without creating a Session. For `RESUME_EXACT`, call `getSession`, resolve WorkspaceRef safely, and publish a fatal safe error on mismatch/ambiguity.

- [ ] **Step 4: Add historical transcript hydration and model/security continuity**

Once a Session/WorkspaceRef is selected, call `listRuns(sessionId, { limit: 100 })`, hydrate public history with `hydrateSessionTranscript`, select model from `session.defaultModel ?? daemonInfo.defaultModel`, and build every new Run with the daemon’s current `defaultRunConfiguration` spread after model/workspace. Do not copy old Run permission, approval or limit fields.

- [ ] **Step 5: Add bounded non-terminal discovery state**

Publish zero/one/multiple non-terminal Run states. A single active Run is attached by Task 7; multiple Runs publish recovery candidates and disable the composer; PENDING publishes `PENDING_RUN_CONFIRMATION`; no path silently picks a newest Run or creates a new Run while another non-terminal Run exists.

- [ ] **Step 6: Run all existing CLI tests plus new resume tests green**

Run: `pnpm exec vitest run apps/cli/test/cli-controller.test.ts apps/cli/test/cli-controller-terminal.test.ts apps/cli/test/main-lifecycle.test.ts apps/cli/test/application-state.test.ts`

Expected: PASS with all Phase 12B/12C behavior retained.

- [ ] **Step 7: Commit the launch/resume controller integration**

```bash
git add apps/cli/src/application/cli-controller.ts apps/cli/src/application/cli-state.ts apps/cli/src/main.tsx apps/cli/test/cli-controller.test.ts apps/cli/test/cli-controller-terminal.test.ts apps/cli/test/main-lifecycle.test.ts apps/cli/test/application-state.test.ts
git commit -m "feat(cli): add durable session resume lifecycle"
```

## Task 7: Attach active Runs, recover boundaries, and preserve cold Timeline replay

**Files:**

- Modify: `apps/cli/src/application/cli-controller.ts`
- Test: `apps/cli/test/cli-controller-recovery.test.ts`
- Test: `apps/cli/test/event-projector.test.ts`

**Interfaces:**

- Controller attaches every selected active Run with `createInitialCliTimelineState(run.id)` followed by `watchRunEvents(run.id, { afterSequence: 0, onOpen, signal })`.
- PENDING calls `startRun` only after `confirmPendingRun(true)`.
- RUNNING/VERIFYING calls `recoverRun` at most once after the stream opens for that connection generation; `ALREADY_ACTIVE` and `SCHEDULED` are normal.
- WAITING_APPROVAL calls `listPendingApprovals` first; non-empty results enter Approval mode, empty results call `recoverRun`.

- [ ] **Step 1: Write failing recovery tests**

```ts
it("starts a recovered PENDING Run only after explicit confirmation", async () => {
  const run = makeRun({ status: "PENDING" });
  const controller = await bootResumedController(run);
  expect(client.startRun).not.toHaveBeenCalled();
  expect(controller.getState().controlMode).toBe("PENDING_RUN_CONFIRMATION");
  await controller.confirmPendingRun(true);
  expect(client.startRun).toHaveBeenCalledTimes(1);
});

it("checks pending approvals before recovering a WAITING_APPROVAL Run", async () => {
  const run = makeRun({ status: "WAITING_APPROVAL" });
  const calls: string[] = [];
  const controller = await bootResumedController(run, {
    listPendingApprovals: async () => { calls.push("approvals"); return { items: [makeApproval() ] }; },
    recoverRun: async () => { calls.push("recover"); return actionResponse(run, "RECOVER"); },
  });
  expect(calls).toEqual(["approvals"]);
  expect(controller.getState().controlMode).toBe("APPROVAL");
});
```

- [ ] **Step 2: Run recovery tests and observe missing active attachment behavior**

Run: `pnpm exec vitest run apps/cli/test/cli-controller-recovery.test.ts`

Expected: FAIL because resumed active Runs are not currently discovered or attached.

- [ ] **Step 3: Implement one active stream attachment path**

Store `ActiveRun` with Run ID, stream generation, stream AbortController, recovery-admitted flag and terminal settlement Promise. Use a generation counter and check it before every event projection. Cold resume always starts at sequence zero; do not seed from historical Timeline state.

- [ ] **Step 4: Implement recovery decisions after stream open**

Wire `onOpen` to publish CONNECTED and, once per generation, dispatch `recoverRun` for RUNNING/VERIFYING. Do not recover on each event. For WAITING_APPROVAL use the canonical pending list first and preserve the Run if no Approval is currently present while Core recovery is scheduled.

- [ ] **Step 5: Run recovery and Timeline regression tests green**

Run: `pnpm exec vitest run apps/cli/test/cli-controller-recovery.test.ts apps/cli/test/event-projector.test.ts apps/cli/test/timeline-reducer.test.ts`

Expected: PASS with cold replay from sequence zero, existing dedup and no duplicate active Run goal.

- [ ] **Step 6: Commit active Run recovery**

```bash
git add apps/cli/src/application/cli-controller.ts apps/cli/src/application/event-projector.ts apps/cli/test/cli-controller-recovery.test.ts apps/cli/test/event-projector.test.ts
git commit -m "feat(cli): reattach and recover active runs"
```

## Task 8: Implement interactive Approval resolution and stale reconciliation

**Files:**

- Modify: `apps/cli/src/application/cli-controller.ts`
- Modify: `apps/cli/src/application/cli-control.ts`
- Create: `apps/cli/src/components/ApprovalDialog.tsx`
- Test: `apps/cli/test/approval-control.test.ts`
- Modify: `apps/cli/test/cli-controller-recovery.test.ts`
- Modify: `apps/cli/test/components.test.tsx`

**Interfaces:**

- `controller.resolveApproval(approvalId, resolution): Promise<boolean>` performs a fresh pending lookup, locks the exact Approval ID, calls `client.resolveApproval(runId, approvalId, resolution)` at most once, reconciles its canonical Run, and returns false for stale/conflict/error cases without reopening the dialog.
- `ApprovalDialog` props are `{ approval: CliApprovalView; selectedIndex: number; submitting: boolean; onMove(delta: -1 | 1): void; onSubmit(): void; onClose(): void }`; it performs no Client call.

- [ ] **Step 1: Write failing Approval controller and component tests**

```ts
it("submits exactly one request on double Enter and starts from Reject", async () => {
  const controller = await controllerWaitingForApproval();
  const promise = controller.resolveApproval(approval.id, { action: "REJECT" });
  const duplicate = controller.resolveApproval(approval.id, { action: "REJECT" });
  await Promise.all([promise, duplicate]);
  expect(client.resolveApproval).toHaveBeenCalledTimes(1);
});

it("does not resolve an Approval that a second client already settled", async () => {
  client.listPendingApprovals = async () => ({ items: [] });
  await expect(controller.resolveApproval(approval.id, { action: "REJECT" })).resolves.toBe(false);
  expect(client.resolveApproval).not.toHaveBeenCalled();
});

it("renders safe fields and never raw action data", () => {
  const rendered = render(
    <ApprovalDialog
      approval={safeApprovalViewWithSecretAction()}
      selectedIndex={0}
      submitting={false}
      onMove={() => undefined}
      onSubmit={() => undefined}
      onClose={() => undefined}
    />,
  );
  expect(rendered.lastFrame()).toContain("Approval required");
  expect(rendered.lastFrame()).not.toContain("secret");
  expect(rendered.lastFrame()).not.toContain("approvalKey");
});
```

- [ ] **Step 2: Run focused Approval tests and observe missing behavior**

Run: `pnpm exec vitest run apps/cli/test/approval-control.test.ts apps/cli/test/components.test.tsx`

Expected: FAIL because no Approval controller methods/dialog exist.

- [ ] **Step 3: Implement Approval state ingestion and exact-ID locking**

Ingest live `approval.requested` via the existing event projector/controller path and resume pending list into sorted `approval.id` keyed state. Do not infer identity from tool name or list position. A stale `approval.resolved` event removes only the matching ID.

- [ ] **Step 4: Implement canonical preflight and resolution**

Before sending, call `listPendingApprovals(runId)` and verify the exact ID remains PENDING. Increment the control generation before the Client call. On conflict or already-resolved state, call `getRun` and `listPendingApprovals`, close/reconcile, and store a recoverable control error. Ignore responses from older generations, including responses arriving after cancellation.

- [ ] **Step 5: Implement safe Ink dialog**

Render title, reason, risk, tool label, required capability labels and safe action summary only. Show Approve once, conditional Run option, and Reject with Reject selected initially. Render `Resolving approval...` and disable selection/submit while in flight. Esc invokes only `onClose`.

- [ ] **Step 6: Run Approval tests green and commit**

Run: `pnpm exec vitest run apps/cli/test/approval-control.test.ts apps/cli/test/components.test.tsx apps/cli/test/cli-controller-recovery.test.ts`

Expected: PASS for ONCE/RUN option mapping, exact ID, stale/external resolution, conflict refetch, privacy and double-submit blocking.

```bash
git add apps/cli/src/application/cli-controller.ts apps/cli/src/application/cli-control.ts apps/cli/src/components/ApprovalDialog.tsx apps/cli/test/approval-control.test.ts apps/cli/test/components.test.tsx apps/cli/test/cli-controller-recovery.test.ts
git commit -m "feat(cli): add interactive approval controls"
```

## Task 9: Implement canonical Ctrl+C cancellation, Ctrl+D detach, and race-safe terminal settlement

**Files:**

- Modify: `apps/cli/src/application/cli-controller.ts`
- Modify: `apps/cli/src/application/cli-control.ts`
- Test: `apps/cli/test/cancellation-control.test.ts`
- Modify: `apps/cli/test/cli-controller-terminal.test.ts`

**Interfaces:**

- `cancelActiveRun(): Promise<boolean>` sends at most one `client.cancelRun(activeRun.runId)` while in flight, invalidates the control generation, and reconciles `response.run.status`.
- `detachActiveRun(): void` aborts only the local stream, sets a safe notice, and never calls `cancelRun`.
- All terminal paths call one `settleTerminal(active, canonicalRun?)` Promise gate; it appends exactly one assistant/terminal history entry, clears active state, enables composer only when no non-terminal Run remains, and aborts the local stream.

- [ ] **Step 1: Write failing cancellation/race tests**

```ts
it("maps Ctrl+C to one canonical cancel request and waits for terminal status", async () => {
  const controller = await controllerWithActiveRun("RUNNING");
  const first = controller.cancelActiveRun();
  const second = controller.cancelActiveRun();
  await Promise.all([first, second]);
  expect(client.cancelRun).toHaveBeenCalledTimes(1);
  expect(controller.getState().activeRun).toBeUndefined();
  expect(controller.getState().activity).toBe("Cancelled");
});

it("does not fake CANCELLED when cancel response is COMPLETED or fails", async () => {
  // Return canonical COMPLETED in one test and reject the HTTP call in another.
  // Assert the status/message and absence of a fabricated CANCELLED terminal entry.
});

it("does not let a stale Approval response reopen UI after Ctrl+C", async () => {
  // Hold resolveApproval, cancel, then release Approval response and assert controlMode !== APPROVAL.
});
```

- [ ] **Step 2: Run cancellation tests and observe missing API/terminal race behavior**

Run: `pnpm exec vitest run apps/cli/test/cancellation-control.test.ts apps/cli/test/cli-controller-terminal.test.ts`

Expected: FAIL because cancellation is absent and terminal settlement is SSE-only.

- [ ] **Step 3: Add the cancellation in-flight and control-generation gate**

If no active Run, return false. If a cancel Promise exists, return that same Promise/result without a second HTTP request. Increment the control generation before calling the Client; publish `CANCELLING` and `Cancelling...`; ignore stale Approval/start/reconnect responses.

- [ ] **Step 4: Reconcile canonical cancel responses**

For terminal `response.run.status`, call the shared settlement gate with that Run. For non-terminal responses, keep the active Run, show `Cancellation could not be confirmed. The Run may still be active.`, and permit a later retry. Never interpret `disposition: SETTLED` alone as cancellation.

- [ ] **Step 5: Make terminal event and cancel response exactly-once**

Guard `settleTerminal` with the per-active-Run Promise; pass a fetched canonical Run for SSE terminal events and the response Run for cancel. Ensure duplicate terminal events, replayed terminal events and the other source observe the existing Promise. Add historical/non-terminal refresh before enabling composer.

- [ ] **Step 6: Implement detach and run cancellation tests green**

Ctrl+D must abort the local stream and produce the daemon-continuation notice without a cancel call. Ctrl+C with no active Run remains exit-only in the App. Run the focused tests.

Run: `pnpm exec vitest run apps/cli/test/cancellation-control.test.ts apps/cli/test/cli-controller-terminal.test.ts`

Expected: PASS for RUNNING, WAITING_APPROVAL, VERIFYING, disconnected cancellation, canonical COMPLETED race, HTTP failure, double Ctrl+C, Approval race, terminal dedup and Ctrl+D.

- [ ] **Step 7: Commit cancellation controls**

```bash
git add apps/cli/src/application/cli-controller.ts apps/cli/src/application/cli-control.ts apps/cli/test/cancellation-control.test.ts apps/cli/test/cli-controller-terminal.test.ts
git commit -m "feat(cli): add active run cancellation controls"
```

## Task 10: Integrate bounded SSE reconnect, cursor continuity and generation invalidation

**Files:**

- Modify: `apps/cli/src/application/cli-controller.ts`
- Modify: `apps/cli/src/application/cli-state.ts`
- Modify: `apps/cli/src/components/ActivityStatus.tsx`
- Modify: `apps/cli/src/components/Header.tsx`
- Test: `apps/cli/test/reconnect-control.test.ts`
- Modify: `apps/cli/test/cli-controller-terminal.test.ts`

**Interfaces:**

- Every cold attach/reconnect has a unique stream generation, an AbortController and one scheduler admission.
- Stream failures leave `activeRun` and canonical Run status unchanged, publish `RECONNECTING` and safe `transportError`, and schedule the exact delay sequence.
- Successful `onOpen` publishes `CONNECTED`, clears transport error, resets scheduler; reconnect opens with `afterSequence = state.timeline.lastDurableSequence`.
- Six failures publish `DISCONNECTED` and the exact bounded manual recovery notice. `reconnectActiveRun()` retries the same Run only.

- [ ] **Step 1: Write failing controller reconnect tests**

```ts
it("reconnects strictly after the last durable sequence and ignores old stream events", async () => {
  const calls: Array<number | undefined> = [];
  // Stream A emits sequences 1..3 then fails; Stream B records afterSequence and emits 4..5.
  expect(calls).toEqual([undefined, 3]);
  expect(controller.getState().timeline.lastDurableSequence).toBe(5);
  expect(controller.getState().timeline.settled.map((entry) => entry.id)).toEqual(expectedOnce);
});

it("does not turn transport failure into Run FAILED and enters DISCONNECTED after six failures", async () => {
  // Drive fake timers and failing streams; assert active Run remains and R can retry.
});
```

- [ ] **Step 2: Run reconnect tests and observe no retry/cursor behavior**

Run: `pnpm exec vitest run apps/cli/test/reconnect-control.test.ts`

Expected: FAIL because stream errors currently write fatalError and no scheduler exists in the controller.

- [ ] **Step 3: Wire `CliReconnectScheduler` into the controller**

Use an injected timer option in controller tests and a production timer adapter in `main`. On stream normal completion or error before terminal, stop the current generation, publish RECONNECTING, and let the scheduler create the next stream. Capture the current durable cursor at reconnect time, never at initial Run creation.

- [ ] **Step 4: Enforce stream generation and stale-event checks**

Increment generation for every attach/reconnect/detach/dispose. The consumer must check active object identity and generation before projection, terminal settlement, error handling or state publication. Old stream events, close errors and Approval responses must not mutate the current Run.

- [ ] **Step 5: Add transport UI state and manual reconnect**

Render transport separately from Run activity, including `Reconnecting n/6` and `Disconnected`. R is handled only in disconnected mode and calls `reconnectActiveRun`; it must not create a Session/Run. Keep raw SSE/event errors out of the UI.

- [ ] **Step 6: Run reconnect, Timeline and existing terminal tests green**

Run: `pnpm exec vitest run apps/cli/test/reconnect-control.test.ts apps/cli/test/cli-controller-terminal.test.ts apps/cli/test/timeline-reducer.test.ts`

Expected: PASS for cursor 3→4/5, ephemeral cursor stability, duplicate replay, old stream isolation, delay/exhaustion/manual retry/dispose and terminal settlement once.

- [ ] **Step 7: Commit reconnect integration**

```bash
git add apps/cli/src/application/cli-controller.ts apps/cli/src/application/cli-state.ts apps/cli/src/components/ActivityStatus.tsx apps/cli/src/components/Header.tsx apps/cli/test/reconnect-control.test.ts apps/cli/test/cli-controller-terminal.test.ts
git commit -m "feat(cli): add bounded SSE reconnect"
```

## Task 11: Add the Session Picker, Run Recovery Picker, Approval dialog and unified input router

**Files:**

- Create: `apps/cli/src/components/SessionPicker.tsx`
- Create: `apps/cli/src/components/RunRecoveryPicker.tsx`
- Modify: `apps/cli/src/components/App.tsx`
- Modify: `apps/cli/src/components/Composer.tsx`
- Modify: `apps/cli/src/components/ActiveTimeline.tsx`
- Modify: `apps/cli/src/components/ActivityStatus.tsx`
- Test: `apps/cli/test/input-precedence.test.tsx`
- Modify: `apps/cli/test/components.test.tsx`

**Interfaces:**

- Components receive view models and callbacks only; they never import `@caelush/client` or call controller Client methods except through callbacks supplied by `App`.
- `SessionPicker` renders at most 100 rows with title, short ID and safe last activity; Up/Down/Enter/Esc call callbacks.
- `RunRecoveryPicker` renders status, goal preview, short Run ID and created time; it never guesses a Run.
- `App` owns one `useInput` router using `routeCliInput` and invokes controller methods or `useApp().exit()` according to the returned action.

- [ ] **Step 1: Write failing Ink/input tests**

```tsx
it("uses Approval Enter instead of Composer Enter", () => {
  const rendered = render(<App controller={controllerWithApproval()} />);
  rendered.stdin.write("\r");
  expect(controller.resolveApproval).toHaveBeenCalledTimes(1);
  expect(controller.submitPrompt).not.toHaveBeenCalled();
});

it("renders Session and Run pickers without leaking internal metadata", () => {
  const rendered = render(<App controller={controllerWithSessionPicker()} />);
  expect(rendered.lastFrame()).toContain("Resume a Session");
  expect(rendered.lastFrame()).not.toContain("database");
  expect(rendered.lastFrame()).not.toContain("providerUrl");
});
```

- [ ] **Step 2: Run component tests and observe missing picker/input behavior**

Run: `pnpm exec vitest run apps/cli/test/input-precedence.test.tsx apps/cli/test/components.test.tsx`

Expected: FAIL because App currently has only the Ctrl+C/D exit handler and no picker/dialog components.

- [ ] **Step 3: Implement pure picker/dialog rendering**

Keep rows bounded and safe. Use visible labels for control hints. Render Approval inline with active Timeline; render transport notice without replacing the entire App with `FatalError` for recoverable failures.

- [ ] **Step 4: Replace competing input handlers with one App router**

Remove the existing unconditional Ctrl+C/D exit handler. Handle the action returned by `routeCliInput` in one `useInput`; when Approval is open, Enter/Arrow/Esc cannot reach Composer; when Session/Run picker is open, navigation cannot reach Composer; when active Run exists Ctrl+C cancels and Ctrl+D detaches; idle Enter remains Composer behavior through `ink-text-input`.

- [ ] **Step 5: Run all CLI component/input tests green**

Run: `pnpm exec vitest run apps/cli/test/input-precedence.test.tsx apps/cli/test/components.test.tsx apps/cli/test/main-lifecycle.test.ts`

Expected: PASS for picker navigation, Approval keyboard behavior, cancellation/detach, disconnected R, safe fatal/recoverable display and all Phase 12C visual regressions.

- [ ] **Step 6: Commit the interactive CLI shell**

```bash
git add apps/cli/src/components apps/cli/test/input-precedence.test.tsx apps/cli/test/components.test.tsx apps/cli/test/main-lifecycle.test.ts
git commit -m "feat(cli): add interactive control surfaces"
```

## Task 12: Add real daemon/SQLite integration and Phase 12D E2E coverage

**Files:**

- Create: `apps/cli/test/phase-12d-e2e.test.tsx`
- Modify: `packages/client/test/client.test.ts` to retain the onOpen regression cases when the shared Client fixture is extended.

**Interfaces:**

- E2E uses the real Fastify daemon composition, file-backed SQLite, EventBus, RunController, Dispatcher, Security, Approval repository, Runtime and Verification; only the external LLM provider is replaced with a deterministic fixture.
- The fixture exposes the real `CaelushClient` to the CLI controller and observes Run ID, ToolInvocation/Approval ID, WorkspaceRef ID/path and durable event sequences through public APIs/events.

- [ ] **Step 1: Write failing E2E scenarios**

Add tests for:

```text
Approval request → dialog → Approve once → same Run → Tool once → completion
Approval request → Reject → Tool not executed → rejection reaches Agent
Ctrl+C during a long provider/Tool → cancel HTTP → durable intent → CANCELLED
SSE disconnect → bounded reconnect after cursor → no duplicate Timeline → completion
Daemon 1 WAITING_APPROVAL → shutdown → Daemon 2 same SQLite → exact Session resume → same Approval/Run → Tool once → completion
Run 1 “Remember ORANGE-731” → Process 2 --continue → Run 2 receives ORANGE-731 from durable Session history
```

- [ ] **Step 2: Run the E2E file and observe missing Phase 12D behavior**

Run: `pnpm exec vitest run apps/cli/test/phase-12d-e2e.test.tsx`

Expected: FAIL in the first missing control/recovery assertion, with no weakening of the E2E to shared-memory callbacks.

- [ ] **Step 3: Implement the real fixtures around existing daemon composition**

Use a temporary file-backed SQLite path and the existing daemon composition setup directly in `phase-12d-e2e.test.tsx`. Restart by disposing the first composition and constructing the second with the same database path. Record the public Client calls and assert that the new CLI process calls `getSession`/`listRuns`/`watchRunEvents`/`resolveApproval`, not `createSession`/`createRun` for recovery. Assert the ORANGE-731 fake provider reads the actual history prefix supplied by the daemon Session history context.

- [ ] **Step 4: Run each E2E scenario individually, then as a file**

Run the named Vitest tests one at a time, then:

Run: `pnpm exec vitest run apps/cli/test/phase-12d-e2e.test.tsx`

Expected: PASS with real durable IDs, no Tool replay, same WorkspaceRef identity and transcript continuity proven.

- [ ] **Step 5: Commit E2E coverage**

```bash
git add apps/cli/test/phase-12d-e2e.test.tsx apps/daemon/test/daemon-control-e2e.test.ts apps/daemon/test/daemon-session-history-e2e.test.ts packages/client/test/client.test.ts
git commit -m "test: cover phase 12d control and recovery e2e"
```

## Task 13: Add architecture/documentation guards and Phase 12D architecture docs

**Files:**

- Create: `docs/architecture/cli-interactive-control.md`
- Create: `docs/architecture/cli-session-recovery.md`
- Create: `docs/architecture/cli-transport-recovery.md`
- Modify: `docs/architecture/cli-agent-timeline.md`
- Modify: `docs/architecture/cli-application-shell.md`
- Modify: `docs/architecture/client-transport.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Create or modify: `tests/architecture/phase-12d-boundaries.test.ts`

**Interfaces:**

- Architecture tests enforce CLI import restrictions, no direct HTTP path literals in CLI, no forbidden Phase 12E strings/entry points, no new RunStatus values, and no raw Approval field rendering.
- Docs describe daemon authority, typed control intents, Approval scope semantics, cancellation/detach, control generations, Session launch modes, WorkspaceRef reuse, transcript hydration, active Run recovery, SSE cursor/generation/reconnect behavior, error classes and Phase 12E exclusions.

- [ ] **Step 1: Write failing architecture/doc coverage**

```ts
it("keeps CLI outside Core/Storage/Runtime/Security/Tools/Verification/LLM", () => {
  const source = readCliSourceTree();
  expect(source).not.toMatch(/@caelush\/(core|storage|runtime|security|tools|verification|llm)/);
  expect(source).not.toContain("/api/v1/");
});

it("documents Phase 12D without introducing Phase 12E runtime behavior", () => {
  expect(read("README.md")).toContain("Phase 12D");
  expect(read("README.md")).toContain("Phase 12E");
});
```

- [ ] **Step 2: Run architecture tests and observe missing docs/guards**

Run: `pnpm exec vitest run tests/architecture/phase-12d-boundaries.test.ts`

Expected: FAIL until the new docs and guard assertions exist.

- [ ] **Step 3: Implement architecture guards and docs**

Use existing architecture-test source scanning conventions. Update README status to 12A/12B/12C/12D COMPLETED, 12E NOT STARTED, Phase 12 IN PROGRESS only after implementation is verified. Add the durable rules from the Phase 12D brief to AGENTS.md verbatim in meaning, including same Session/WorkspaceRef, canonical status, approval privacy, bounded reconnect, stale stream isolation, pending Approval precedence and scope exclusions.

- [ ] **Step 4: Run architecture and CLI regression tests green**

Run: `pnpm exec vitest run tests/architecture/phase-12d-boundaries.test.ts apps/cli/test/architecture.test.ts apps/cli/test/components.test.tsx`

Expected: PASS with no prohibited imports, direct transport calls, Phase 12E leakage or privacy violations.

- [ ] **Step 5: Commit docs and guards**

```bash
git add docs/architecture/cli-interactive-control.md docs/architecture/cli-session-recovery.md docs/architecture/cli-transport-recovery.md docs/architecture/cli-agent-timeline.md docs/architecture/cli-application-shell.md docs/architecture/client-transport.md README.md AGENTS.md tests/architecture/phase-12d-boundaries.test.ts
git commit -m "docs: define phase 12d control architecture"
```

## Task 14: Focused verification, full regression, clean build and delivery gate

**Files:**

- No production files unless a verification failure demonstrates a defect in a changed file.
- Review: all changed files, `git status --short`, `git diff --check`.

**Interfaces:**

- Produces evidence for every Phase 12D checklist category and a final completion report; does not begin Phase 12E.

- [ ] **Step 1: Run focused Phase 12D test groups serially**

Run these commands one at a time and record output:

```bash
pnpm exec vitest run apps/cli/test/cli-args.test.ts
pnpm exec vitest run apps/cli/test/session-resume.test.ts
pnpm exec vitest run apps/cli/test/cli-control.test.ts apps/cli/test/approval-control.test.ts
pnpm exec vitest run apps/cli/test/cancellation-control.test.ts
pnpm exec vitest run apps/cli/test/reconnect-scheduler.test.ts apps/cli/test/reconnect-control.test.ts
pnpm exec vitest run apps/cli/test/input-precedence.test.tsx apps/cli/test/components.test.tsx
pnpm exec vitest run apps/cli/test/phase-12d-e2e.test.tsx
pnpm exec vitest run tests/architecture/phase-12d-boundaries.test.ts
```

Expected: every command exits 0; record test counts and any skipped tests.

- [ ] **Step 2: Measure changed-file formatting and repository debt**

Run: `pnpm exec prettier --check <each changed .ts/.tsx/.md/.json/.yml file>` and then `pnpm format:check`.

Expected: every changed file reports no warning; total warning count is no greater than the measured baseline 773. Do not run a repository-wide write formatter.

- [ ] **Step 3: Run full verification serially**

Run exactly:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands exit 0; plain `pnpm test` is the authoritative test gate and does not depend on `--retry`.

- [ ] **Step 4: Perform clean-build verification without `git clean`**

Remove only the current worktree’s generated `apps/*/dist`, `packages/*/dist`, and `*.tsbuildinfo` paths using explicit resolved paths, then run:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands exit 0 from the clean generated-artifact state.

- [ ] **Step 5: Inspect diff/status and verify scope**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Confirm no generated artifacts, no forbidden package imports, no direct Client HTTP paths, no daemon auto-launch/packaging/non-interactive code, no new RunStatus and no Phase 12E implementation.

- [ ] **Step 6: Commit final verification-only documentation adjustments**

Review README/AGENTS/report metadata against the Phase 12D checklist. If a verified checklist item is missing from those files, write the smallest documentation patch, run `git diff --check`, and make one scoped commit. Do not amend prior commits merely for presentation and do not alter runtime behavior in this step.

- [ ] **Step 7: Push the actual Phase 12D branch without force**

```bash
git push -u origin codex/phase-12d-interactive-control-session-recovery
```

If the network TLS issue remains, report the exact failure and do not substitute a fabricated remote SHA.

- [ ] **Step 8: Verify remote SHA and clean working tree**

```bash
$LOCAL_SHA = git rev-parse HEAD
$REMOTE_SHA = (git ls-remote --heads origin refs/heads/codex/phase-12d-interactive-control-session-recovery).Split()[0]
Write-Output "LOCAL_SHA=$LOCAL_SHA"
Write-Output "REMOTE_SHA=$REMOTE_SHA"
git status --short
```

Expected: `LOCAL_SHA == REMOTE_SHA` and an empty status. If remote verification is blocked by the same TLS failure, mark the delivery gate incomplete rather than claiming Phase 12D COMPLETED.

- [ ] **Step 9: Produce the Phase 12D Completion Report and stop**

Report the 102 requested categories from the brief: Phase 12C SHA/remote/base/worktree; all baselines; characterization and research; launch/resume/session/workspace/model/security/transcript/recovery behavior; Approval/Cancel/Detach; transport/reconnect/cursor/generation/settlement/input/error behavior; focused/unit/component/E2E/regression/architecture tests; clean build/format/check; commits/push/SHA/status; capability summary and next round. Explain plainly how 12D changes the user from observer to controller. After the report, do not execute Phase 12E.
