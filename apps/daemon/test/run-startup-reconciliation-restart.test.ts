import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRunSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type AgentRun,
} from "@caelush/protocol";
import { RunController } from "@caelush/core";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { describe, expect, it } from "vitest";

import { reconcileStaleRuns } from "../src/execution/run-startup-reconciliation.js";
import { RunExecutionSupervisor } from "../src/execution/run-execution-supervisor.js";
import { EventBus } from "../../../packages/storage/test/support/test-event-notifier.js";
import { verificationPlanner } from "../../../packages/storage/test/support/fixtures.js";
import { modelTurnResult } from "../../../packages/storage/test/support/model-turns.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
  type FakeFrozenModelTurnExecutor,
} from "../../../packages/storage/test/support/run-agent-execution.js";
import { testRunMessageAuthority } from "../../../packages/core/test/support/run-message-authority.js";

/**
 * The real crash this test reproduces.
 *
 * ```text
 * generation 1
 *   Run A  is driving a provider turn when the process dies  -> durable RUNNING + an open RUNNING Step
 *   Run B  sits at a WAITING_TOOL_RESULTS boundary            -> durable RUNNING + a continuation
 *   Run C  already completed                                  -> durable COMPLETED
 *   Run D  was never started                                  -> durable PENDING
 *   ---- the process is gone; nothing was disposed, nothing was drained ----
 * generation 2 (a fresh daemon)
 *   reconcileStaleRuns() enumerates the non-terminal Runs and hands each to the recovery authority
 * ```
 *
 * What must hold afterwards is the whole point of §27:
 *
 * - a Run a dead generation left `RUNNING` is *settled*, never permanently `RUNNING`;
 * - the stale provider Step is not resent — recovery performs **zero** provider turns;
 * - a stale side-effectful Tool is not replayed — the boundary still holds the *same* unanswered
 *   tool requests, so a tool effect can never be executed twice;
 * - a terminal Run is never reopened;
 * - a `PENDING` Run is never auto-started.
 *
 * The crash is *not* simulated with `composition.dispose()`: the first generation is abandoned
 * exactly the way a killed process leaves it — its durable rows are already written and only the
 * SQLite handle is released. The controller, its locks and its in-flight provider turn are simply
 * left behind, which is precisely why the next generation has to reconcile.
 */

const now = { value: 10 };

function makeRun(
  sessionId: AgentRun["sessionId"],
  options: {
    readonly createdAt: number;
    readonly status?: AgentRun["status"];
  },
): AgentRun {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId,
    goal: "reconcile me",
    status: options.status ?? "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(options.createdAt),
    ...(options.status === undefined || options.status === "PENDING"
      ? {}
      : { startedAt: createTimestampMs(options.createdAt) }),
    ...(options.status === "COMPLETED" ? { finishedAt: createTimestampMs(options.createdAt + 1) } : {}),
  });
}

/**
 * Compose the Run Layer the way a host does.
 *
 * There is no facade and no legacy loop: the controller is handed the frozen collaborator ports —
 * the model catalog, the frozen turn executor, the Step identity factory and the Context Engine —
 * exactly like the daemon composition.
 */
function createController(
  storage: CaelushStorage,
  modelTurns: FakeFrozenModelTurnExecutor,
): RunController {
  const execution = testRunAgentExecution({
    executor: modelTurns,
    createStepId: () => createStepId(),
  });
  return new RunController({
    agentExecution: execution.factory,
    executionStore: storage.execution,
    messages: testRunMessageAuthority({
      records: (runId) => storage.messageRecords.listByRun(runId),
    }),
    events: new EventBus(storage.eventReader),
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "synthetic context is not durable conversation",
        contextLimits: { maxInputTokens: 1000 },
      }),
    },
    clock: { now: () => createTimestampMs(now.value++) },
    eventIdFactory: { create: () => createEventId() },
    verificationPlanner,
  });
}

async function openDatabase(directory: string): Promise<CaelushStorage> {
  return openCaelushStorage({ path: path.join(directory, "caelush.sqlite") });
}

/** Poll durable state until a predicate holds, so the test observes commits rather than guessing. */
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for durable state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Daemon startup stale-Run reconciliation across a real SQLite restart", () => {
  it("settles a mid-turn Run, never resends a stale provider turn or Tool, and never reopens or auto-starts a Run", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-startup-reconcile-"));
    await mkdir(path.join(directory, "project"));

    // ── generation 1 ────────────────────────────────────────────────────────────────────────────
    const first = await openDatabase(directory);
    const sessionId = createSessionId();
    const runMidTurn = makeRun(sessionId, { createdAt: 1 });
    const runAwaitingTools = makeRun(sessionId, { createdAt: 2 });
    const runCompleted = makeRun(sessionId, { createdAt: 3, status: "COMPLETED" });
    const runPending = makeRun(sessionId, { createdAt: 4 });

    await first.sessions.insert({
      id: sessionId,
      createdAt: createTimestampMs(1),
      updatedAt: createTimestampMs(1),
      metadata: {},
    });
    for (const run of [runMidTurn, runAwaitingTools, runCompleted, runPending]) {
      await first.runs.insert(run);
    }

    // Run A: a provider turn that never answers. The Step becomes durable before any provider I/O, so
    // waiting for the durable RUNNING + open Step is waiting for the exact moment a real kill would
    // have caught this Run.
    const hangingExecutor = fakeFrozenModelTurnExecutor(() => new Promise<never>(() => {}));
    const midTurnController = createController(first, hangingExecutor);
    const abandonedTurn = midTurnController.start(runMidTurn.id);
    abandonedTurn.catch(() => {
      // The abandoned turn is expected to reject once the handle is gone; nothing may surface it.
    });
    await waitUntil(async () => {
      const snapshot = await first.execution.load(runMidTurn.id);
      return snapshot?.run.status === "RUNNING" && snapshot.activeStep !== undefined;
    });
    const staleStepId = (await first.execution.load(runMidTurn.id))?.activeStep?.id;
    if (staleStepId === undefined) throw new Error("expected a durable stale Step");

    // Run B: parked at a Tool boundary with an unanswered, side-effectful request.
    const toolExecutor = fakeFrozenModelTurnExecutor((_request, _signal, callIndex) =>
      callIndex === 0
        ? modelTurnResult({
            text: "restart the service",
            toolCalls: [
              { id: "call_restart", name: "exec_command", input: { command: "npm run restart" } },
            ],
            finishReason: "TOOL_CALLS",
          })
        : modelTurnResult({ text: "unreachable", finishReason: "STOP" }),
    );
    const toolController = createController(first, toolExecutor);
    const parked = await toolController.start(runAwaitingTools.id);
    expect(parked.status).toBe("WAITING_TOOL_RESULTS");
    expect(toolExecutor.callCount()).toBe(1);

    // ── the crash ───────────────────────────────────────────────────────────────────────────────
    // Only the SQLite handle is released. Nothing is drained, nothing is disposed, the in-flight
    // provider turn is simply left behind — the durable state above is all the next generation sees.
    await first.close();

    // ── generation 2 ────────────────────────────────────────────────────────────────────────────
    const second = await openDatabase(directory);
    // An executor that refuses every turn: if recovery re-opened a provider turn, `callCount` would
    // be non-zero and the assertion below would fail.
    const recoveryExecutor = fakeFrozenModelTurnExecutor(() => {
      throw new Error("recovery must not open a provider turn");
    });
    const recoveryController = createController(second, recoveryExecutor);
    const supervisor = new RunExecutionSupervisor({
      runs: second.runs,
      controller: recoveryController,
    });

    const summary = await reconcileStaleRuns({ runs: second.runs, supervisor });
    await supervisor.drain();

    // The enumeration saw exactly the two non-terminal Runs — never the terminal one, never PENDING.
    expect(summary.examined).toBe(2);
    expect([...summary.scheduled].sort()).toEqual(
      [runAwaitingTools.id, runMidTurn.id].sort(),
    );
    expect(summary.alreadyActive).toEqual([]);
    expect(summary.noopTerminal).toEqual([]);
    expect(summary.failed).toEqual([]);

    // §27: a stale provider Step is never resent, and a stale side-effectful Tool is never replayed.
    expect(recoveryExecutor.callCount()).toBe(0);

    // §27: the Run the dead generation left RUNNING is settled — it is not permanently RUNNING, and
    // the stale Step is failed closed rather than resent.
    const settledMidTurn = await second.runs.get(runMidTurn.id);
    expect(settledMidTurn?.status).toBe("FAILED");
    expect(settledMidTurn?.currentStepId).toBeUndefined();
    expect((await second.steps.get(staleStepId))?.status).toBe("FAILED");

    // §27: the parked Run keeps the *same* unanswered requests, so no Tool effect can run twice. It is
    // still legitimately waiting for the host to submit results - that is not a stale Run.
    const parkedSnapshot = await second.execution.load(runAwaitingTools.id);
    expect(parkedSnapshot?.run.status).toBe("RUNNING");
    expect(parkedSnapshot?.continuation?.type).toBe("WAITING_TOOL_RESULTS");
    if (parkedSnapshot?.continuation?.type !== "WAITING_TOOL_RESULTS") {
      throw new Error("expected the parked Tool boundary to survive recovery");
    }
    expect(parkedSnapshot.continuation.pendingDecision.toolRequests).toEqual([
      { externalCallId: "call_restart", toolName: "exec_command", args: { command: "npm run restart" } },
    ]);
    expect(parkedSnapshot.continuation.receivedResults).toBeUndefined();

    // §25: a terminal Run is never reopened, and a PENDING Run is never auto-started.
    expect((await second.runs.get(runCompleted.id))?.status).toBe("COMPLETED");
    expect((await second.runs.get(runPending.id))?.status).toBe("PENDING");

    // And the bounded query now reflects the reconciliation: only the still-waiting Run remains.
    const remaining = await second.runs.listRecoverable();
    expect(remaining.map((run) => run.id)).toEqual([runAwaitingTools.id]);

    await second.close();
    await rm(directory, { recursive: true, force: true });
  });
});
