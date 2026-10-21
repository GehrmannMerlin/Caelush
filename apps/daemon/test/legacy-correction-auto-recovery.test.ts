import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ApiId } from "@caelush/ai";
import { createTimestampMs } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { answer, finish, toolCall } from "./support/ai-fixture.js";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";
import { reconcileStaleRuns } from "../src/execution/run-startup-reconciliation.js";

let disposeFixture: (() => Promise<void>) | undefined;

afterEach(async () => {
  await disposeFixture?.();
  disposeFixture = undefined;
});

class HistoricalCorrectionAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly requests: ApiAdapterStreamInput[] = [];
  private turns = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.requests.push(input);
    this.turns += 1;
    return this.turn(this.turns);
  }

  private async *turn(index: number): AsyncGenerator<AIAdapterEvent> {
    if (index === 1) {
      yield* toolCall("historical-plan", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "inspect",
            step: "Inspect the existing task state",
            status: "in_progress",
            acceptance: ["Continue from the durable history."],
          },
        ],
        execution: {
          goal: "Resume an ordinary correction wait without asking the user.",
          constraints: [],
          discoveries: [],
          decisions: [],
          unresolved: [],
          nextAction: "Read the accepted correction result and continue.",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    yield* answer("The recovered Run continued from its accepted history.");
  }
}

const legacyResourcePolicy = {
  mode: "ADAPTIVE",
  operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
  batch: { maxToolCallsPerTurn: 16 },
  progress: {
    windowTurns: 8,
    identicalCallNudgeThreshold: 3,
    noProgressTurnsBeforeReplan: 2,
    replansBeforePause: 2,
  },
  hardLimits: {},
  inactivity: {},
};

async function createHistoricalWait() {
  const adapter = new HistoricalCorrectionAdapter();
  const fixture = await createReliabilityFixture({
    adapter,
    resourcePolicy: legacyResourcePolicy,
    resourceCorrectionRecoveryPolicy: null,
  });
  disposeFixture = () => fixture.dispose();
  const created = await fixture.storage.resourceGovernance.createOrGet(fixture.run.id, {
    policyVersion: "adaptive-resource-governance.v1",
    mode: "ADAPTIVE",
    now: fixture.run.createdAt,
  });
  await fixture.storage.resourceGovernance.compareAndSwap(fixture.run.id, created.revision, {
    ...created,
    consecutiveNoProgressTurns: 3,
    replanCount: 2,
    revision: created.revision + 1,
    updatedAt: createTimestampMs(fixture.run.createdAt + 1),
  });
  const parked = await fixture.composition.controller.start(fixture.run.id);
  expect(parked.run.status).toBe("WAITING_RESOURCE");
  expect(await fixture.storage.toolInvocations.listByRun(fixture.run.id)).toHaveLength(0);
  return { adapter, fixture };
}

describe("historical ordinary correction recovery", () => {
  it("recovers through RunController.recover without a continue action and accepts the upgrade with results", async () => {
    const { adapter, fixture } = await createHistoricalWait();
    const nextGeneration = await fixture.restartComposition();

    const result = await nextGeneration.controller.recover(fixture.run.id);

    expect(result.run.status).toBe("COMPLETED");
    expect(adapter.requests).toHaveLength(2);
    expect(JSON.stringify(adapter.requests[1]?.request.messages)).toContain("Not executed");
    expect(await fixture.storage.toolInvocations.listByRun(fixture.run.id)).toHaveLength(0);
    const progress = await fixture.storage.resourceGovernance.get(fixture.run.id);
    expect(progress).toMatchObject({
      policyVersion: "adaptive-resource-governance.v2",
      correctionRecovery: {
        version: 1,
        runId: fixture.run.id,
        reason: "LEGACY_NO_PROGRESS",
        fromCorrectionVersion: "HISTORICAL_V1",
        effectiveCorrectionVersion: "AUTONOMOUS_CORRECTION_V2",
        authority: "DAEMON_AUTO_CORRECTION_V1",
      },
      lastAcceptedBoundary: {
        kind: "TOOL_RESULTS",
        messageIds: [expect.any(String)],
      },
    });
  }, 30_000);

  it("routes startup reconciliation through the same supervisor and Core recovery path", async () => {
    const { adapter, fixture } = await createHistoricalWait();
    const nextGeneration = await fixture.restartComposition();

    const summary = await reconcileStaleRuns({
      runs: fixture.storage.runs,
      supervisor: nextGeneration.supervisor,
    });
    await nextGeneration.supervisor.drain();

    expect(summary.scheduled).toContain(fixture.run.id);
    expect((await fixture.storage.runs.get(fixture.run.id))?.status).toBe("COMPLETED");
    expect(adapter.requests).toHaveLength(2);
    expect(JSON.stringify(adapter.requests[1]?.request.messages)).toContain("Not executed");
  }, 30_000);
});
