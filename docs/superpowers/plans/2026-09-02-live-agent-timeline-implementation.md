# Live Agent Timeline & Execution Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Add one bounded, browser-safe Timeline projection in \`@caelush/client\`, reuse it from CLI, and render real daemon Agent Activity in the Web session workspace.

**Architecture:** The shared client package owns Timeline data types, event reduction, terminal flushing, safe presentation helpers, UTF-8 bounds, and event identity validation. CLI files become compatibility adapters over that implementation, while \`WebSessionManager\` applies the same projection to its existing single SSE stream and React renders only the resulting safe state.

**Tech Stack:** TypeScript 6, ESM, \`@caelush/protocol\`, React 19, Vite 8, Vitest 4, Ink 7, real daemon/SQLite integration fixtures, browser \`TextEncoder\`.

**Spec:** \`docs/superpowers/specs/2026-09-02-live-agent-timeline-design.md\`

## Global Constraints

- The existing \`@caelush/protocol\` \`AgentEvent\` contract remains the only wire contract; no Timeline-specific protocol entities are added.
- Core, Security, Runtime, Tools, Verification, Storage, and daemon production surfaces are not modified unless a concrete existing public-event blocker is proven.
- React remains a renderer, not a source of Agent state. CLI/Web do not maintain independent Timeline reducers.
- Only \`USER_VISIBLE\` events for the selected Run are projected.
- Durable identity is validated with \`eventId\` and \`durability.sequence\`. Exact replay is ignored; conflicting identity/order fails closed with a safe Timeline error.
- The projection remains bounded: 8 KiB text, 256 settled entries, 32 active entries, and 1024 seen events by default.
- Phase 13C does not implement Approval controls, Cancellation, Reconnect, after-sequence replay orchestration, active-Run reattachment, or Recovery.
- Schema-only events (\`plan.updated\`, \`tool.output\`, \`shell.output\`, \`process.output\`, \`verification.started\`, and \`verification.completed\`) may remain reducer compatibility cases for existing CLI behavior, but Web product behavior must not depend on them.
- Browser bundles must not require \`Buffer\`, \`process\`, or \`node:*\` polyfills.
- All new behavior is introduced test-first: write a focused failing test, run it and record the expected failure, implement the smallest change, then rerun the focused test.
- Do not run \`pnpm format\`; use Prettier checks only, including changed files.

## Task 3 review follow-up — Verification bounded projection integrity

This is an internal corrective follow-up under Task 3, not a new Phase or Phase 13C round. Before implementation, the following policy is frozen:

- Capacity parameters only determine when bounded state evicts data; they never directly determine whether retained metadata is trusted.
- `verification.finalized(planId)` succeeds only when the target aggregate is provable from retained trusted state: a real retained total source plus complete unique terminal outcomes whenever those outcomes are needed for the aggregate.
- Outcome/plan-metadata eviction records real `planId` provenance in bounded `verificationOutcomeIntegrity`, with `affectedPlanIds` and `unknownAffected`; it never retains evidence IDs or raw result payloads.
- If target evidence is explicitly affected, or provenance is unknown and target-specific complete proof is unavailable, finalization fails closed and appends no `FINALIZED` Timeline entry. Counts are never guessed and `total: 0` is never fabricated for missing evidence.
- Overflow for another Plan does not automatically poison a Plan that remains independently provable. `unknownAffected` is consumed as a target-specific proof requirement, not as a global limit proxy.
- The implementation must remove any `maxSeenEvents <= 1` (or equivalent capacity-based trust) condition, wire integrity state into the canonical finalization decision, and add the six requested eviction/provenance regressions.

## File Map

Create the shared browser-safe implementation in:

- \`packages/client/src/timeline/model.ts\` — generic Timeline state, entry, verification, retry, limits, and initial-state types.
- \`packages/client/src/timeline/presentation.ts\` — safe tool/file labels, path validation, control sanitization, and Unicode-safe UTF-8 truncation.
- \`packages/client/src/timeline/reducer.ts\` — deterministic \`AgentEvent\` projection, durable identity gate, aggregation, bounds, and terminal flush.
- \`packages/client/src/timeline/index.ts\` — focused shared Timeline exports.
- \`packages/client/test/timeline-presentation.test.ts\` — browser-safe UTF-8 and safe presentation tests.
- \`packages/client/test/timeline-reducer.test.ts\` — shared production-event reducer, aggregation, bounds, and terminal-flush tests.

Modify public/shared integration files:

- \`packages/client/src/index.ts\` — export shared Timeline values and types.
- \`apps/cli/src/application/timeline-model.ts\` — compatibility aliases/re-exports only.
- \`apps/cli/src/application/timeline-reducer.ts\` — compatibility re-exports only.
- \`apps/cli/src/application/timeline-presentation.ts\` — compatibility re-exports only.

Modify Web application files:

- \`apps/web/src/application/session-manager.ts\` — add Timeline state and project every event on the existing stream.
- \`apps/web/src/app.ts\` — pass Timeline state and keep empty snapshots valid.
- \`apps/web/src/components/session-workspace.ts\` — render Timeline between history and composer.
- \`apps/web/src/components/timeline.ts\` — render bounded safe activity without lifecycle or private-data inference.
- \`apps/web/src/styles.css\` — add timeline-specific responsive, status, focus, and reduced-motion styles.
- \`apps/web/test/session-manager.test.ts\` — test one stream, activity projection, lifecycle refresh authority, Run reset, and terminal retention.
- \`apps/web/test/timeline.test.tsx\` — test supported-event rendering and forbidden-surface absence.

Add real integration/build coverage:

- \`apps/web/test/daemon-timeline-e2e.test.ts\` — deterministic daemon/SQLite/Agent/Tool/Verification to WebSessionManager Timeline path.
- \`apps/web/test/browser-safe-build.test.ts\` — build-output assertions for shared client/Web bundles.

---

### Task 1: Define the shared Timeline model and browser-safe presentation primitives

**Files:**

- Create: \`packages/client/src/timeline/model.ts\`
- Create: \`packages/client/src/timeline/presentation.ts\`
- Create: \`packages/client/src/timeline/index.ts\`
- Create: \`packages/client/test/timeline-presentation.test.ts\`

**Interfaces:**

- Produces generic \`TimelineEntry\`, \`TimelineEntryKind\`, \`TimelineEntryStatus\`, \`TimelineVerificationCheck\`, \`TimelineVerificationGroup\`, \`TimelineRetry\`, \`TimelineState\`, \`TimelineOptions\`, \`TimelineLimits\`, \`DEFAULT_TIMELINE_LIMITS\`, \`resolveTimelineLimits()\`, and \`createInitialTimelineState()\`.
- Produces \`formatToolLabel()\`, \`formatFileChange()\`, \`formatFileRead()\`, \`formatFileMove()\`, \`workspaceRelativePath()\`, \`sanitizeTerminalText()\`, and \`truncateTimelineText()\`.
- \`TimelineEntry\` contains only bounded safe scalar projection fields. It never contains raw protocol payloads, Tool args, credentials, provider bodies, shell/process output, or the approval \`action\` object.
- \`TimelineState\` includes \`activeLlm\` in addition to the existing active Tool/Approval/Process arrays, so LLM activity is represented without a Web-specific state model.

- [ ] **Step 1: Write the failing browser-safe presentation tests**

    import { describe, expect, it } from "vitest";
    import {
      sanitizeTerminalText,
      truncateTimelineText,
      workspaceRelativePath,
    } from "../src/timeline/presentation.js";

    describe("shared Timeline presentation", () => {
      it("bounds Unicode text by UTF-8 bytes without splitting emoji", () => {
        const value = truncateTimelineText("头头头-keep-head-😀😀😀-keep-tail-尾尾尾", 40);
        expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(40);
        expect(value).toContain("… output truncated …");
        expect(value).not.toContain("\uFFFD");
      });

      it("sanitizes terminal control sequences without Node globals", () => {
        expect(sanitizeTerminalText("ok\u001b]0;secret\u0007\u001b[31m 😀\u001b[0m\r\nnext")).toBe(
          "ok 😀\nnext",
        );
      });

      it("rejects absolute and parent-traversal paths", () => {
        expect(workspaceRelativePath("src/index.ts")).toBe("src/index.ts");
        expect(workspaceRelativePath("C:\\secret.txt")).toBeUndefined();
        expect(workspaceRelativePath("../secret.txt")).toBeUndefined();
      });
    });

- [ ] **Step 2: Run the new tests to verify the expected RED failure**

  Run: \`pnpm exec vitest run packages/client/test/timeline-presentation.test.ts\`

  Expected: FAIL because the new shared presentation module does not exist.

- [ ] **Step 3: Implement the model and presentation helpers**

  Use these exact defaults:

    export const DEFAULT_TIMELINE_LIMITS: TimelineLimits = Object.freeze({
      maxTextBytes: 8 * 1024,
      maxSettledEntries: 256,
      maxActiveEntries: 32,
      maxSeenEvents: 1024,
    });

    export function createInitialTimelineState(
      runId?: RunId,
      options: TimelineOptions = {},
    ): TimelineState {
      const limits = resolveTimelineLimits(options);
      return {
        ...(runId === undefined ? {} : { runId }),
        limits,
        settled: [],
        activeTools: [],
        activeApprovals: [],
        activeProcesses: [],
        activeLlm: [],
        verification: [],
        retries: [],
        lastDurableSequence: 0,
        seenEvents: [],
        omittedActivity: false,
      };
    }

  Implement \`truncateTimelineText()\` with one \`TextEncoder\`, code-point iteration, a visible truncation marker, and UTF-8 continuation-byte handling for suffixes. Do not call \`Buffer\`, \`process\`, or \`node:*\`.

- [ ] **Step 4: Run the focused tests to verify GREEN**

  Run: \`pnpm exec vitest run packages/client/test/timeline-presentation.test.ts\`

  Expected: PASS for Unicode, control-sequence, and path assertions.

- [ ] **Step 5: Commit the shared primitives**

    git add packages/client/src/timeline
    git add packages/client/test/timeline-presentation.test.ts
    git commit -m "feat(client): add browser-safe timeline model"

### Task 2: Implement the shared deterministic AgentEvent reducer

**Files:**

- Modify: \`packages/client/src/timeline/model.ts\`
- Create: \`packages/client/src/timeline/reducer.ts\`
- Modify: \`packages/client/test/timeline-reducer.test.ts\`

**Interfaces:**

- Produces \`reduceTimelineEvent(state: TimelineState, event: AgentEvent): TimelineState\`.
- Produces \`flushTimelineForTerminal(state, status): TimelineState\`.
- The reducer is pure, does not mutate caller state, returns the same object for ignored/replayed events, and returns \`error: "Timeline event order could not be verified."\` for a durable identity/sequence conflict.

- [ ] **Step 1: Write failing reducer tests for safety gates and bounds**

    it("accepts visible events and ignores other Runs and visibility", () => {
      const initial = createInitialTimelineState(runId);
      const visible = eventOf("reasoning.summary", 1, { summary: "检查认证代码" });
      const hidden = { ...visible, visibility: "DEBUG" as const };
      const otherRun = { ...visible, runId: createRunId() };

      const projected = reduceTimelineEvent(initial, visible);
      expect(projected.settled[0]?.text).toBe("检查认证代码");
      expect(reduceTimelineEvent(projected, hidden)).toBe(projected);
      expect(reduceTimelineEvent(projected, otherRun)).toBe(projected);
    });

    it("ignores exact replay and fails closed on sequence conflict", () => {
      const event = eventOf("reasoning.summary", 1, { summary: "same" });
      const projected = reduceTimelineEvent(createInitialTimelineState(runId), event);
      expect(reduceTimelineEvent(projected, event)).toBe(projected);

      const conflict = reduceTimelineEvent(
        projected,
        eventOf("reasoning.summary", 1, { summary: "different" }),
      );
      expect(conflict.error).toBe("Timeline event order could not be verified.");
    });

    it("bounds retained activity after 1000 durable events", () => {
      let state = createInitialTimelineState(runId, {
        maxSettledEntries: 3,
        maxActiveEntries: 2,
        maxSeenEvents: 4,
      });
      for (let sequence = 1; sequence <= 1000; sequence += 1) {
        state = reduceTimelineEvent(
          state,
          eventOf("reasoning.summary", sequence, { summary: "event-" + sequence }),
        );
      }
      expect(state.settled.length).toBeLessThanOrEqual(3);
      expect(state.seenEvents.length).toBeLessThanOrEqual(4);
    });

- [ ] **Step 2: Run the reducer tests to verify the expected RED failure**

  Run: \`pnpm exec vitest run packages/client/test/timeline-reducer.test.ts\`

  Expected: FAIL because the reducer module and exported functions do not exist.

- [ ] **Step 3: Implement registration, bounded append, and all production cases**

  Start the reducer with this safety gate:

    export function reduceTimelineEvent(state: TimelineState, event: AgentEvent): TimelineState {
      if (state.error !== undefined) return state;
      if (state.runId !== undefined && state.runId !== event.runId) return state;
      if (event.visibility !== "USER_VISIBLE") return state;

      const registration = registerEvent(state, event);
      if (registration.kind === "DUPLICATE") return state;
      if (registration.kind === "CONFLICT") {
        return { ...state, error: "Timeline event order could not be verified." };
      }
      return reduceRegisteredEvent(registration.state, event);
    }

  Port the existing CLI aggregation behavior into this module with generic types and Task 1 presentation helpers. Keep compatibility cases for \`plan.updated\`, \`tool.output\`, \`shell.output\`, \`process.output\`, \`verification.started\`, and \`verification.completed\` for CLI regression only; never retain their raw payloads for Web.

  Implement these production cases:

  - \`reasoning.summary\`: bounded entry with adjacent duplicate suppression.
  - \`llm.started/completed/failed\`: one active entry keyed by Step/model, settled with only provider/model strings, aggregate usage counters, or sanitized error.
  - \`tool.requested/started/completed/failed\`: one entry keyed by invocation ID, retaining safe \`toolName\`, title, summary, status, and no args.
  - File events: safe standalone entries or aggregation into the sole active Tool for the same Step.
  - Shell events: safe public command label plus exit code/signal; no output rendering contract.
  - Process events: public process summary/status; no output rendering contract.
  - Retry events: bounded upsert by Step/attempt.
  - Verification events: counts, payload labels, statuses, duration, repair/final outcome; no evidence IDs/result payload.
  - Approval events: title, reason, risk, scope, invocation ID; never the \`action\` object.
  - Error/budget events: sanitized settled entries.
  - Terminal flush: clear active Tool/LLM/Process/Approval/Retry/Verification/current plan state and append bounded interruption entries.

- [ ] **Step 4: Add focused tests for every production event family**

  In this test file define the IDs and event factory used by every case so the tests exercise the real protocol shape:

    const runId = createRunId();
    const sessionId = createSessionId();
    const stepId = createStepId();
    const invocationId = createToolInvocationId();
    const observationId = createObservationId();

    function eventOf(
      type: AgentEvent["type"],
      sequence: number,
      payload: unknown,
      overrides: Partial<AgentEvent> = {},
    ): AgentEvent {
      return {
        eventId: createEventId(),
        schemaVersion: 1,
        type,
        runId,
        sessionId,
        stepId,
        timestamp: sequence,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence },
        payload,
        ...overrides,
      } as AgentEvent;
    }

    it("aggregates Tool lifecycle and file activity", () => {
      let state = createInitialTimelineState(runId);
      state = reduceTimelineEvent(state, eventOf("tool.requested", 1, {
        invocationId,
        toolName: "read_file",
        riskLevel: "LOW",
      }));
      state = reduceTimelineEvent(state, eventOf("tool.started", 2, { invocationId }));
      state = reduceTimelineEvent(state, eventOf("file.read", 3, { path: "src/auth.ts" }));
      state = reduceTimelineEvent(state, eventOf("tool.completed", 4, {
        invocationId,
        observationId,
      }));

      expect(state.activeTools).toEqual([]);
      expect(state.settled).toHaveLength(1);
      expect(state.settled[0]).toMatchObject({
        kind: "TOOL",
        toolName: "read_file",
        status: "COMPLETED",
      });
      expect(JSON.stringify(state)).not.toContain("args");
    });

    it("projects verification progress and final outcome from payload labels", () => {
      let state = createInitialTimelineState(runId);
      const planId = createVerificationPlanId();
      const checkId = createVerificationCheckId();
      state = reduceTimelineEvent(state, eventOf("verification.planned", 1, {
        planId,
        sourceStepId: stepId,
        checkCount: 1,
        plannerVersion: "test-planner",
        counts: { required: 1, ifAvailable: 0, advisory: 0 },
      }));
      state = reduceTimelineEvent(state, eventOf("verification.check.started", 2, {
        planId,
        checkId,
        ordinal: 0,
        kind: "TASK",
        purpose: "ACCEPTANCE",
        stage: "ACCEPTANCE",
      }));
      state = reduceTimelineEvent(state, eventOf("verification.check.completed", 3, {
        planId,
        checkId,
        status: "PASSED",
        evidenceIds: [],
        durationMs: 12,
      }));
      state = reduceTimelineEvent(state, eventOf("verification.finalized", 4, {
        planId,
        outcome: "PASSED",
        failedCheckIds: [],
        errorCheckIds: [],
      }));

      expect(state.settled.at(-1)).toMatchObject({
        kind: "VERIFICATION",
        status: "FINALIZED",
      });
    });

  Also cover shell exit code and signal, process started/stopped, reasoning deduplication, retries, error/budget sanitization, tool failure, approval read-only data, and terminal flush for \`COMPLETED\`, \`FAILED\`, \`CANCELLED\`, \`TIMEOUT\`, \`MAX_STEPS_REACHED\`, and \`BUDGET_EXCEEDED\`.

- [ ] **Step 5: Run shared reducer and CLI regression tests**

  Run: \`pnpm exec vitest run packages/client/test/timeline-reducer.test.ts apps/cli/test/timeline-reducer.test.ts apps/cli/test/timeline-presentation.test.ts apps/cli/test/event-projector.test.ts\`

  Expected: all shared tests and existing CLI tests pass.

- [ ] **Step 6: Commit the shared reducer**

    git add packages/client/src/timeline/model.ts packages/client/src/timeline/reducer.ts packages/client/test/timeline-reducer.test.ts
    git commit -m "feat(client): project agent events into bounded timeline"

### Task 3: Export shared Timeline and convert CLI files to adapters

**Files:**

- Modify: \`packages/client/src/index.ts\`
- Modify: \`apps/cli/src/application/timeline-model.ts\`
- Modify: \`apps/cli/src/application/timeline-reducer.ts\`
- Modify: \`apps/cli/src/application/timeline-presentation.ts\`
- Modify: \`apps/cli/test/timeline-reducer.test.ts\`

**Interfaces:**

- \`@caelush/client\` exports generic Timeline values/types from its package root.
- CLI adapters expose current names such as \`CliTimelineState\` and \`createInitialCliTimelineState\` as aliases to the shared implementation.
- No Timeline reducer or presentation implementation remains under \`apps/cli/src/application\`.

- [ ] **Step 1: Write the failing adapter contract test**

    import { createInitialTimelineState, reduceTimelineEvent } from "@caelush/client";
    import { createInitialCliTimelineState } from "../src/application/timeline-model.js";
    import { reduceTimelineEvent as reduceCliTimelineEvent } from "../src/application/timeline-reducer.js";

    it("resolves CLI Timeline through the shared implementation", () => {
      expect(createInitialCliTimelineState(runId)).toEqual(createInitialTimelineState(runId));
      expect(reduceCliTimelineEvent).toBe(reduceTimelineEvent);
    });

- [ ] **Step 2: Run the adapter test to verify the expected RED failure**

  Run: \`pnpm exec vitest run apps/cli/test/timeline-reducer.test.ts\`

  Expected: FAIL because the client package has no Timeline export and the CLI still owns separate function objects.

- [ ] **Step 3: Add package exports and replace CLI bodies with aliases**

  Export from \`packages/client/src/timeline/index.ts\`:

    export { createInitialTimelineState, DEFAULT_TIMELINE_LIMITS, flushTimelineForTerminal,
      formatRunTerminal, reduceTimelineEvent, resolveTimelineLimits } from "./reducer.js";
    export * from "./presentation.js";
    export type * from "./model.js";

  Export that index from \`packages/client/src/index.ts\`. Replace the CLI three implementation files with re-exports and explicit type aliases. Keep CLI-only lifecycle behavior in \`event-projector.ts\` and Ink components; do not move reconnect/recovery/approval-control logic into the client.

- [ ] **Step 4: Run CLI regression and package typechecks**

  Run: \`pnpm exec vitest run packages/client/test apps/cli/test/timeline-reducer.test.ts apps/cli/test/timeline-presentation.test.ts apps/cli/test/event-projector.test.ts\`

  Run: \`pnpm --filter @caelush/client typecheck\` and \`pnpm --filter @caelush/cli typecheck\`

  Expected: all tests and both typechecks exit 0.

- [ ] **Step 5: Commit the exports and adapters**

    git add packages/client/src/index.ts packages/client/src/timeline apps/cli/src/application/timeline-model.ts apps/cli/src/application/timeline-reducer.ts apps/cli/src/application/timeline-presentation.ts apps/cli/test/timeline-reducer.test.ts
    git commit -m "refactor(cli): reuse shared timeline projection"

### Task 4: Integrate Timeline into WebSessionManager without a second SSE

**Files:**

- Modify: \`apps/web/src/application/session-manager.ts\`
- Modify: \`apps/web/src/app.ts\`
- Modify: \`apps/web/test/session-manager.test.ts\`

**Interfaces:**

- \`WebSessionSnapshot.timeline\` is a \`TimelineState\` in every snapshot, including the empty bootstrap snapshot.
- A new Run starts with \`createInitialTimelineState(run.id)\`; session selection does not fabricate historical Timeline.
- The existing \`watchRunEvents()\` loop reduces every matching Event and calls \`getRun()\` only for lifecycle Events.
- Terminal lifecycle refresh flushes Timeline before the retained current-page snapshot is settled.

- [ ] **Step 1: Write failing manager tests for one stream and selective refresh**

    it("projects activity from one SSE without refreshing for non-lifecycle events", async () => {
      const run = makeRun({ status: "PENDING" });
      const client = makeClient({
        createRunResult: run,
        watchEvents: [
          eventOf(run, "reasoning.summary", 1, { summary: "检查认证模块" }),
          eventOf(run, "tool.requested", 2, {
            invocationId,
            toolName: "read_file",
            riskLevel: "LOW",
          }),
          eventOf(run, "status.changed", 3, { from: "RUNNING", to: "VERIFYING" }),
        ],
      });
      const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
      manager.beginDraft();

      await expect(manager.submitPrompt("inspect")).resolves.toBe(true);
      await waitFor(() => manager.getSnapshot().timeline.settled.length > 0);

      expect(manager.getSnapshot().timeline.settled[0]?.text).toBe("检查认证模块");
      expect(client.watchRunEvents).toHaveBeenCalledTimes(1);
      expect(client.getRun).toHaveBeenCalledTimes(1);
    });

- [ ] **Step 2: Run manager tests to verify the expected RED failure**

  Run: \`pnpm exec vitest run apps/web/test/session-manager.test.ts\`

  Expected: FAIL because snapshots do not yet have \`timeline\` and activity Events are discarded before lifecycle filtering.

- [ ] **Step 3: Add Timeline to snapshots and project inside the existing stream**

  Import \`createInitialTimelineState\`, \`flushTimelineForTerminal\`, \`reduceTimelineEvent\`, and \`TimelineState\`. Add \`timeline\` to \`WebSessionSnapshot\`, the snapshot patch type, \`initialSnapshot()\`, and \`EMPTY_SESSION_SNAPSHOT\`.

  Change the stream loop to this exact shape:

    for await (const event of this.options.client.watchRunEvents(active.run.id, {
      signal: active.controller.signal,
    })) {
      if (this.activeLifecycle !== active || this.disposed) return;

      const timeline = reduceTimelineEvent(this.snapshot.timeline, event);
      this.publish({ timeline });

      if (!isLifecycleEvent(event)) continue;
      const refreshed = await this.options.client.getRun(active.run.id);
      if (this.activeLifecycle !== active || this.disposed) return;
      this.publishActiveRun(refreshed, "ACTIVE");
      if (isTerminalRunStatus(refreshed.status)) {
        await this.settleLifecycle(active, refreshed);
        return;
      }
    }

  Initialize/reset the Timeline when a new Run is created. For a selected active Run, initialize a fresh Run-scoped Timeline only; do not replay historical events. In terminal settlement include \`flushTimelineForTerminal(this.snapshot.timeline, run.status)\` before retaining the snapshot.

- [ ] **Step 4: Add manager tests for reset, flush, identity, and lifecycle authority**

  Assert that new Runs have empty Timeline state with the new Run ID; terminal snapshots have no active Tool/LLM/Process/Approval/Retry/Verification entries but retain settled entries; non-lifecycle events do not call \`getRun()\`; lifecycle Events do call \`getRun()\); and reducer conflicts expose only the safe order-verification error.

- [ ] **Step 5: Run Web manager tests and typecheck**

  Run: \`pnpm exec vitest run apps/web/test/session-manager.test.ts\`

  Run: \`pnpm --filter @caelush/web typecheck\`

  Expected: both commands exit 0.

- [ ] **Step 6: Commit Web session projection**

    git add apps/web/src/application/session-manager.ts apps/web/src/app.ts apps/web/test/session-manager.test.ts
    git commit -m "feat(web): project live timeline from run events"

### Task 5: Render the safe Timeline in the Web workspace

**Files:**

- Create: \`apps/web/src/components/timeline.ts\`
- Modify: \`apps/web/src/components/session-workspace.ts\`
- Modify: \`apps/web/src/styles.css\`
- Create: \`apps/web/test/timeline.test.tsx\`
- Modify: \`apps/web/test/presentation.test.tsx\`

**Interfaces:**

- \`Timeline\` accepts \`timeline: TimelineState\` and returns a React element; it contains no client calls, reducer calls, or private-data lookups.
- \`SessionWorkspace\` accepts \`timeline: TimelineState\` and renders it after history, before the composer.
- Web presentation maps known Tool names to Chinese, preserves model names/paths/IDs/unknown Tool names, and renders only shared projection fields.

- [ ] **Step 1: Write failing render tests for supported activity and forbidden surfaces**

    const runId = createRunId();
    const sessionId = createSessionId();
    const stepId = createStepId();
    const invocationId = createToolInvocationId();

    function eventOf(type: AgentEvent["type"], sequence: number, payload: unknown): AgentEvent {
      return {
        eventId: createEventId(),
        schemaVersion: 1,
        type,
        runId,
        sessionId,
        stepId,
        timestamp: sequence,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1, sequence },
        payload,
      } as AgentEvent;
    }

    it("renders public activity and no later-phase controls", () => {
      let timeline = createInitialTimelineState(runId);
      const planId = createVerificationPlanId();
      timeline = reduceTimelineEvent(timeline, eventOf("reasoning.summary", 1, {
        summary: "正在检查认证代码……",
      }));
      timeline = reduceTimelineEvent(timeline, eventOf("tool.requested", 2, {
        invocationId,
        toolName: "read_file",
        riskLevel: "LOW",
      }));
      timeline = reduceTimelineEvent(timeline, eventOf("tool.started", 3, { invocationId }));
      timeline = reduceTimelineEvent(timeline, eventOf("file.read", 4, {
        path: "src/routes/auth.ts",
      }));
      timeline = reduceTimelineEvent(timeline, eventOf("shell.started", 5, {
        invocationId,
        command: "typecheck",
      }));
      timeline = reduceTimelineEvent(timeline, eventOf("shell.completed", 6, {
        invocationId,
        exitCode: 0,
      }));
      timeline = reduceTimelineEvent(timeline, eventOf("verification.planned", 7, {
        planId,
        sourceStepId: stepId,
        checkCount: 3,
        plannerVersion: "test-planner",
        counts: { required: 3, ifAvailable: 0, advisory: 0 },
      }));

      const html = renderToStaticMarkup(<Timeline timeline={timeline} />);
      expect(html).toContain("执行过程");
      expect(html).toContain("推理摘要");
      expect(html).toContain("读取文件");
      expect(html).toContain("src/routes/auth.ts");
      expect(html).toContain("验证");
      expect(html).not.toContain("Approve");
      expect(html).not.toContain("Reject");
      expect(html).not.toContain("Cancel");
      expect(html).not.toContain("Inspector");
      expect(html).not.toContain("Terminal");
      expect(html).not.toContain("stdout");
    });

- [ ] **Step 2: Run rendering tests to verify the expected RED failure**

  Run: \`pnpm exec vitest run apps/web/test/timeline.test.tsx\`

  Expected: FAIL because \`Timeline\` does not exist and \`SessionWorkspace\` has no Timeline prop.

- [ ] **Step 3: Implement the renderer and presentation styles**

  Use a single Web label table:

    const WEB_TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
      read_file: "读取文件",
      list_directory: "查看目录",
      find_files: "查找文件",
      search_text: "搜索文本",
      apply_patch: "修改文件",
      exec_command: "执行命令",
      write_stdin: "与进程交互",
      git_status: "检查 Git 状态",
      git_diff: "查看 Git 变更",
    });

  Render settled and active projection arrays in deterministic order with active \`●\` and settled \`✓\`/failure marks. Render verification check \`purpose\`, \`kind\`, \`stage\`, status, and duration only from projection fields. Never render \`currentPlan\`, raw output chunks, approval action objects, Evidence IDs, or event payload objects.

  Update \`SessionWorkspace\` and \`app.ts\` to pass Timeline. Add semantic classes, status text, mobile wrapping, visible focus styles, and \`prefers-reduced-motion: reduce\` behavior. Do not add a sidebar, inspector, or control buttons.

- [ ] **Step 4: Run rendering tests and inspect markup**

  Run: \`pnpm exec vitest run apps/web/test/timeline.test.tsx apps/web/test/presentation.test.tsx\`

  Expected: PASS with public labels present and forbidden controls/data absent.

- [ ] **Step 5: Commit Web Timeline presentation**

    git add apps/web/src/components/timeline.ts apps/web/src/components/session-workspace.ts apps/web/src/styles.css apps/web/test/timeline.test.tsx apps/web/test/presentation.test.tsx
    git commit -m "feat(web): render live agent timeline"

### Task 6: Prove the real daemon path and browser-safe production build

**Files:**

- Create: \`apps/web/test/daemon-timeline-e2e.test.ts\`
- Create: \`apps/web/test/browser-safe-build.test.ts\`
- Modify: \`apps/web/package.json\` only if a test script is strictly required; do not add a dependency when an existing runner works.

**Interfaces:**

- The integration test uses real daemon/SQLite/Agent/Tool/Runtime/Verification infrastructure, \`CaelushClient\`, and \`WebSessionManager\`.
- It does not mock \`watchRunEvents()\`, insert fake Timeline DOM, inject fake SSE, or use a fake Tool/Verification path.
- The build test searches the actual production output for \`Buffer\`, \`process\`, and \`node:\` markers.

- [ ] **Step 1: Write the failing real integration test**

    it("projects real Tool, File, Verification, and verified completion events", async () => {
      const workspacePath = await makeWorkspace("caelush-web-timeline-e2e-", "API_KEY=real-value\n");
      const provider = new TimelineProvider();
      const daemon = await startDaemon({
        databasePath: join(workspacePath, "caelush.db"),
        port: 0,
        sseHeartbeatIntervalMs: 0,
        providerOverrides: [provider],
        defaultModel: { provider: "timeline-fixture", model: "timeline-model" },
        logger: false,
      });
      const client = new CaelushClient({ baseUrl: daemon.url });
      const manager = new WebSessionManager({
        client,
        workspace,
        info: await client.getInfo(),
      });
      await manager.loadSessions();
      manager.beginDraft();

      await expect(manager.submitPrompt("inspect the workspace safely")).resolves.toBe(true);
      await waitFor(() => manager.getSnapshot().activeRun === undefined);

      const timeline = manager.getSnapshot().timeline;
      expect(timeline.settled.some((entry) => entry.kind === "TOOL")).toBe(true);
      expect(timeline.settled.some((entry) => entry.kind === "FILE")).toBe(true);
      expect(timeline.settled.some((entry) => entry.kind === "VERIFICATION")).toBe(true);
      expect(manager.getSnapshot().history.some((entry) => entry.kind === "ASSISTANT")).toBe(true);
      expect(JSON.stringify(timeline)).not.toContain("API_KEY=real-value");
      await daemon.close();
    });

- [ ] **Step 2: Run the integration test to verify the expected RED failure**

  Run: \`pnpm exec vitest run apps/web/test/daemon-timeline-e2e.test.ts\`

  Expected: FAIL because the Web manager and Timeline are not yet connected to the real production stream.

- [ ] **Step 3: Implement the deterministic fixture using real dependencies**

  Reuse the deterministic provider shape from \`apps/cli/test/daemon-timeline-e2e.test.tsx\`: first provider turn requests \`read_file\`, the real Dispatcher/Runtime emits Tool/File events, continuation returns a final candidate, and real Verification emits planned/check/finalized before \`COMPLETED\`. Keep the workspace isolated. Do not add a backend emitter or relax production Security policy.

- [ ] **Step 4: Run integration and browser-safe build tests**

  Run: \`pnpm exec vitest run apps/web/test/daemon-timeline-e2e.test.ts apps/web/test/browser-safe-build.test.ts\`

  Expected: real daemon reaches verified completion with Tool/File/Verification entries and the production output contains no Node-only dependency marker.

- [ ] **Step 5: Run Web build and browser smoke**

  Run: \`pnpm --filter @caelush/web build\`

  Verify with the available local browser or Playwright runner at desktop and mobile widths:

    open Web host
    create session
    submit deterministic task
    observe 执行过程
    observe 真实读取文件 and Tool Activity
    observe 验证
    observe verified assistant result

  Check that Timeline content wraps without clipping, active and settled marks differ, paths remain readable, focus is visible, and reduced-motion removes entrance animation. Do not insert Timeline DOM or mock SSE.

- [ ] **Step 6: Commit integration and build coverage**

    git add apps/web/test/daemon-timeline-e2e.test.ts apps/web/test/browser-safe-build.test.ts
    git commit -m "test(web): verify real agent timeline flow"

### Task 7: Full verification, delivery seals, and local cleanup

**Files:**

- Modify: only changed files identified by preceding tasks if a verification failure exposes a concrete defect.
- Test: all existing repository tests and release checks.

**Interfaces:**

- Produces the implementation delivery commit with message \`feat(web): add live agent execution timeline\`.
- Produces matching local/remote task and master SHA seals and leaves only local \`master\` with a clean worktree.

- [ ] **Step 1: Run focused verification**

    pnpm exec vitest run packages/client/test/timeline-reducer.test.ts packages/client/test/timeline-presentation.test.ts apps/cli/test/timeline-reducer.test.ts apps/cli/test/timeline-presentation.test.ts apps/cli/test/event-projector.test.ts apps/web/test/session-manager.test.ts apps/web/test/timeline.test.tsx apps/web/test/daemon-timeline-e2e.test.ts apps/web/test/browser-safe-build.test.ts
    pnpm lint
    pnpm typecheck
    pnpm build

  Expected: every command exits 0. If a command fails, add a regression test before changing production code and rerun the smallest relevant command.

- [ ] **Step 2: Run final repository regression and release verification**

    pnpm test
    pnpm build:release
    pnpm test:release
    pnpm format:check
    git diff --check

  Expected: all commands exit 0. Do not run \`pnpm format\`.

- [ ] **Step 3: Create the required implementation delivery commit**

    git add packages/client apps/cli apps/web
    git commit -m "feat(web): add live agent execution timeline"

  Record \`TASK_LOCAL_SHA\` with \`git rev-parse HEAD\` and confirm \`git status --short\` is empty before pushing.

- [ ] **Step 4: Push and verify the remote task seal**

    git push -u origin codex/phase-13c-live-agent-timeline-execution-visualization
    git rev-parse HEAD
    git ls-remote --heads origin refs/heads/codex/phase-13c-live-agent-timeline-execution-visualization

  Expected: \`TASK_LOCAL_SHA == TASK_REMOTE_SHA\`; only then continue.

- [ ] **Step 5: Fast-forward master and verify the final master seal**

    git switch master
    git merge --ff-only codex/phase-13c-live-agent-timeline-execution-visualization
    git push origin master
    git rev-parse master
    git ls-remote --heads origin refs/heads/master

  Expected: merge reports fast-forward and \`LOCAL_MASTER_SHA == REMOTE_MASTER_SHA == TASK_SHA\`.

- [ ] **Step 6: Delete the local task branch and verify cleanup**

    git branch -d codex/phase-13c-live-agent-timeline-execution-visualization
    git branch
    git worktree list
    git status --short

  Expected: local branches contain only \`master\`, worktrees contain only \`D:/Develop/Caelush\`, and the working tree is clean. Keep the remote task branch.

- [ ] **Step 7: Produce the Phase 13C Completion Report**

  Report starting SHA, task branch/SHA, remote task SHA, final master SHA, remote master SHA, shared architecture, browser-safe UTF-8 strategy, supported/unsupported Event families, single-SSE manager behavior, bounds, actual Web components, real integration/browser smoke evidence, verification commands, security regression answers, deferred Phase 13D/13E scope, and both delivery seals. Stop after the report; do not begin Phase 13D.
