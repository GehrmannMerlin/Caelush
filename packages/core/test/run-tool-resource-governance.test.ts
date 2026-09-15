import {
  RunResourcePolicySchema,
  type RunResourcePolicy,
  type TimestampMs,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import type {
  ResourceGovernancePort,
  ResourceGovernanceState,
} from "../src/resource-governance-port.js";
import {
  answerTurn,
  eventTypes,
  harness3d,
  makeRunD,
  stubToolBatches,
  toolResultItem,
  toolTurn,
  type ToolBatchAnswer,
} from "./support/phase-3d-tool-turn.js";

/**
 * Phase 3D — resource admission, budget refusal and cancellation at the Tool boundary.
 *
 * ```text
 * EXECUTE_TOOL_BATCH
 *        ↓
 * resource admission          ← before the first Tool handler
 *        ↓
 * Tool execution
 * ```
 *
 * The ordering is the point: `RENEW_AND_ALLOW` commits its lease through the ledger's
 * compare-and-swap *before* the batch may run, a `REPLAN` writes no Tool invocation at all, and a
 * `HARD_STOP` is a budget refusal rather than a Tool error.
 */

/** A resource ledger that behaves like the durable one. */
function resourceLedger(initial?: Partial<ResourceGovernanceState>) {
  let state: ResourceGovernanceState = {
    runId: "run_placeholder" as never,
    policyVersion: "adaptive-resource-governance.v1",
    mode: "ADAPTIVE",
    leaseEpoch: 1,
    leaseStartAgentTurns: 0,
    leaseStartToolCalls: 0,
    agentTurnsConsumed: 0,
    toolOperationsConsumed: 0,
    consecutiveNoProgressTurns: 0,
    replanCount: 0,
    resourceGuardState: "NONE",
    recentFingerprints: [],
    revision: 1,
    createdAt: 1 as TimestampMs,
    updatedAt: 1 as TimestampMs,
    ...initial,
  };
  const cas: { expected: number; next: ResourceGovernanceState }[] = [];
  const port: ResourceGovernancePort = {
    async get() {
      return state;
    },
    async createOrGet(runId, input) {
      state = { ...state, runId, mode: input.mode };
      return state;
    },
    async compareAndSwap(_runId, expectedRevision, next) {
      if (expectedRevision !== state.revision) throw new Error("resource CAS lost");
      cas.push({ expected: expectedRevision, next });
      state = next;
      return state;
    },
  };
  return {
    port,
    cas,
    current: () => state,
    set(patch: Partial<ResourceGovernanceState>) {
      state = { ...state, ...patch };
    },
  };
}

const policy = (overrides: DeepPartial<RunResourcePolicy> = {}): RunResourcePolicy =>
  RunResourcePolicySchema.parse({
    mode: "ADAPTIVE",
    operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
    batch: { maxToolCallsPerTurn: 8 },
    progress: {
      windowTurns: 8,
      identicalCallNudgeThreshold: 3,
      noProgressTurnsBeforeReplan: 4,
      replansBeforePause: 2,
    },
    hardLimits: {},
    inactivity: {},
    ...overrides,
  });

type DeepPartial<T> = { readonly [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function completeAnswer(): ToolBatchAnswer {
  return {
    kind: "COMPLETED",
    results: [
      toolResultItem({
        externalCallId: "call_a",
        toolName: "read_file",
        content: "body",
        invocationId: "tiv_a" as never,
      }),
    ],
  };
}

describe("Phase 3D resource admission", () => {
  it("admits a normal batch and records no allocation", async () => {
    const ledger = resourceLedger();
    const batches = stubToolBatches([completeAnswer()]);
    const h = harness3d({
      run: makePolicyRun(policy()),
      script: (call) =>
        call === 0 ? toolTurn([{ id: "call_a", name: "read_file" }]) : answerTurn(),
      toolBatches: batches,
      extra: { resourceGovernance: ledger.port },
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("AWAITING_VERIFICATION");
    // No lease was renewed and no replan was recorded, because the governor decided neither.
    expect(ledger.cas).toHaveLength(1);
    expect(ledger.current().leaseEpoch).toBe(1);
    expect(ledger.current().replanCount).toBe(0);
    expect(batches.physicalExecutions).toBe(1);
  });

  it("renews an expired lease through the durable CAS before the batch runs", async () => {
    const ledger = resourceLedger({ agentTurnsConsumed: 5, leaseStartAgentTurns: 0 });
    const batches = stubToolBatches([completeAnswer()]);
    const h = harness3d({
      run: makePolicyRun(
        policy({
          operationalLease: { maxAgentTurns: 1, maxToolOperations: 1_000 },
        }),
      ),
      script: (call) =>
        call === 0 ? toolTurn([{ id: "call_a", name: "read_file" }]) : answerTurn(),
      toolBatches: batches,
      extra: { resourceGovernance: ledger.port },
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("AWAITING_VERIFICATION");
    // The lease was renewed exactly once, and the batch ran only afterwards.
    expect(ledger.current().leaseEpoch).toBe(2);
    expect(batches.physicalExecutions).toBe(1);
    expect(ledger.cas.length).toBeGreaterThanOrEqual(2);
  });

  it("turns a batch that is too large into synthetic results without dispatching anything", async () => {
    const ledger = resourceLedger();
    const batches = stubToolBatches([completeAnswer()]);
    const calls = [
      { id: "call_a", name: "read_file" },
      { id: "call_b", name: "read_file" },
      { id: "call_c", name: "read_file" },
    ];
    const h = harness3d({
      run: makePolicyRun(policy({ batch: { maxToolCallsPerTurn: 1 } })),
      script: (call) => (call === 0 ? toolTurn(calls) : answerTurn("done")),
      toolBatches: batches,
      extra: { resourceGovernance: ledger.port },
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    // Physical Tool calls: zero. The model asked for three, and the governor refused the batch.
    expect(batches.physicalExecutions).toBe(0);
    expect(batches.calls).toHaveLength(0);
    // The durable replan accounting advanced exactly once, after the synthetic results were durable.
    expect(ledger.current().replanCount).toBe(1);
    // And the model was handed one synthetic result per call it asked for, in assistant order. The
    // Run Layer persists the model's view rather than appending a second copy to the conversation.
    const accepted = h.store.commits
      .map((commit) =>
        commit.continuation?.operation === "SET" ? commit.continuation.checkpoint : undefined,
      )
      .filter((checkpoint) => checkpoint?.type === "WAITING_TOOL_RESULTS")
      .map((checkpoint) =>
        checkpoint?.type === "WAITING_TOOL_RESULTS" ? checkpoint.receivedResults : undefined,
      )
      .filter((results) => results !== undefined);
    expect(accepted.at(0)?.map((message) => message.toolCallId)).toEqual([
      "call_a",
      "call_b",
      "call_c",
    ]);
    // The Run kept reasoning rather than failing.
    expect(result.status).toBe("AWAITING_VERIFICATION");
  });

  it("parks the Run on WAITING_RESOURCE with the exact durable replan count", async () => {
    const ledger = resourceLedger({ consecutiveNoProgressTurns: 3, replanCount: 2 });
    const batches = stubToolBatches([completeAnswer()]);
    const h = harness3d({
      run: makePolicyRun(
        policy({
          progress: {
            windowTurns: 8,
            noProgressTurnsBeforeReplan: 2,
            replansBeforePause: 2,
            identicalCallNudgeThreshold: 1,
          },
        }),
      ),
      script: (call) =>
        call === 0 ? toolTurn([{ id: "call_a", name: "read_file" }]) : answerTurn(),
      toolBatches: batches,
      extra: { resourceGovernance: ledger.port },
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("WAITING_RESOURCE");
    expect(h.store.snapshot.run.status).toBe("WAITING_RESOURCE");
    expect(h.store.snapshot.state?.status).toBe("WAITING_RESOURCE");
    const continuation = h.store.snapshot.continuation;
    expect(continuation?.type).toBe("WAITING_RESOURCE");
    if (continuation?.type === "WAITING_RESOURCE") {
      expect(continuation.reason).toBe("NO_PROGRESS");
      // The frozen `RESOURCE_WAIT` result carries a reason and nothing else, so the count comes
      // from the Core-private observation — the number the admission decision actually read.
      expect(continuation.replanCount).toBe(2);
      expect(continuation.sourceStepId).toBe(h.allocatedSteps[0]);
    }
    // Nothing was dispatched, and the Run published both of its own lifecycle events.
    expect(batches.physicalExecutions).toBe(0);
    const types = eventTypes(h.notifications);
    expect(types).toContain("status.changed");
    expect(types.filter((type) => type === "status.changed")).toHaveLength(2);
  });

  it("hard-stops the batch as a budget refusal with the exact accounting", async () => {
    // The resource ledger has already accounted five Tool operations, and this batch asks for two
    // more against a limit of six: the batch cannot fit, so it must not run at all.
    const ledger = resourceLedger({ toolOperationsConsumed: 5 });
    const batches = stubToolBatches([completeAnswer()]);
    const h = harness3d({
      run: makePolicyRun(policy({ hardLimits: { maxToolCalls: 6 } })),
      script: (call) =>
        call === 0
          ? toolTurn([
              { id: "call_a", name: "read_file", input: { path: "a.ts" } },
              { id: "call_b", name: "read_file", input: { path: "b.ts" } },
            ])
          : answerTurn(),
      toolBatches: batches,
      extra: {
        resourceGovernance: ledger.port,
        resources: {
          cancelOwnedResources: async () => ({ stoppedResourceIds: [], confirmed: true }),
        },
      },
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    // The Run settles terminally, exactly as the LLM budget authority settles one: the durable Run
    // and AgentState both read `BUDGET_EXCEEDED`, and the controller reports the settled Run as
    // terminal rather than inventing a distinct result status for it.
    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("BUDGET_EXCEEDED");
    expect(h.store.snapshot.run.status).toBe("BUDGET_EXCEEDED");
    expect(h.store.snapshot.state?.status).toBe("BUDGET_EXCEEDED");
    // The Run published its own budget settlement and never a failure.
    expect(eventTypes(h.notifications)).not.toContain("run.failed");
    // Nothing was dispatched, and the Run settled terminally rather than reporting a Tool error.
    expect(batches.physicalExecutions).toBe(0);
    const budget = h.notifications.find((event) => event.type === "budget.exceeded");
    expect(budget).toBeDefined();
    expect(JSON.stringify(budget)).toContain("TOOL_CALLS");
    expect(h.notifications.filter((event) => event.type === "budget.exceeded")).toHaveLength(1);
    expect(eventTypes(h.notifications)).not.toContain("run.failed");
  });
});

/**
 * A Run carrying the resource policy under test.
 *
 * `Run.limits` stays generous on purpose: the structural step budget and the resource policy's hard
 * limits are *different* authorities, and a test about one of them must not be decided by the other
 * first.
 */
function makePolicyRun(resourcePolicy: RunResourcePolicy) {
  return makeRunD({
    resourcePolicy,
    limits: { maxSteps: 20, maxToolCalls: 64, timeoutMs: 100_000 },
  });
}
