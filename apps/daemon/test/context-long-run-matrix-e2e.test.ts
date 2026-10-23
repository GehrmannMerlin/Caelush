import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ApiId } from "@caelush/ai";
import { UTF8_BYTES_PER_TOKEN } from "@caelush/agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { answer, finish, toolCall } from "./support/ai-fixture.js";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";

/**
 * The long-run matrix, as one parameterised acceptance and not four scripts.
 *
 * ```text
 * CAELUSH_LONGRUN_STEPS    75 | 130 | 250 | 400   how many model requests the Run makes
 * CAELUSH_LONGRUN_POLICY   default | legacy       the policy the daemon freezes the Run against
 * ```
 *
 * Every combination is the same workload — one update_plan, then one closed 40-line Tool result per
 * Step, then a final answer — and every assertion reads durable state: the SQLite epoch chain, the
 * checkpoints, the message records. Nothing here branches on the step count to decide *what the
 * model does*; the step count only decides how long the same script runs. A Run that resumed
 * correctly and a Run that ignored every piece of feedback would both reach COMPLETED here, which is
 * exactly the claim this file is allowed to make:
 *
 * ```text
 * proves        the production composition keeps ordered history, bounded requests, an intact epoch
 *               chain and durable compaction/rollover across 75–400 Steps, under both policies
 * cannot prove  that a model uses the feedback it is given. That is
 *               `scripts/reliability-real-model-eval.mjs`, reported separately.
 * ```
 *
 * `default` is not a hand-written `WORKING_SET_V2` object: the fixture asks the composed daemon's own
 * resolver, the authority `createRun` calls. `context-budget-default-policy.test.ts` proves the HTTP
 * create-run route reaches that resolver; this file proves the resulting policy survives 400 Steps.
 */

const STEPS = Number(process.env["CAELUSH_LONGRUN_STEPS"] ?? "75");
const POLICY = (process.env["CAELUSH_LONGRUN_POLICY"] ?? "default").toLowerCase();

if (!Number.isSafeInteger(STEPS) || STEPS < 40) {
  throw new RangeError(
    `CAELUSH_LONGRUN_STEPS must be an integer of at least 40, got ${String(STEPS)}`,
  );
}
if (POLICY !== "default" && POLICY !== "legacy") {
  throw new RangeError(`CAELUSH_LONGRUN_POLICY must be "default" or "legacy", got ${POLICY}`);
}

/** A 1M-token window, as the Run this work started from ran on. */
const MODEL_LIMITS = { contextWindowTokens: 1_048_576, maxOutputTokens: 8_192 };

/**
 * A lease small enough that a long Run must renew it repeatedly.
 *
 * The numbers come from the Run's frozen policy, not from constants in this file: the point is that a
 * 400-Step Run keeps working across many leases, not that 12 is a magic turn count.
 */
const RESOURCE_POLICY = {
  mode: "ADAPTIVE",
  correctionVersion: "AUTONOMOUS_CORRECTION_V2",
  operationalLease: { maxAgentTurns: 12, maxToolOperations: 24 },
  batch: { maxToolCallsPerTurn: 2 },
  progress: {
    windowTurns: 8,
    identicalCallNudgeThreshold: 3,
    noProgressTurnsBeforeReplan: 4,
    replansBeforePause: 2,
  },
  hardLimits: {},
  inactivity: {},
} as const;

function summaryText(): string {
  return JSON.stringify({
    goal: "Complete the synthetic long-run workload.",
    constraints: ["Preserve user intent and accepted plan state."],
    completedWork: ["Older closed tool batches were summarized."],
    inProgress: ["Continue from the most recent closed batch."],
    blocked: [],
    importantDiscoveries: ["The active turn remains open across tool batches."],
    keyDecisions: ["Keep the newest tool batch and current user request."],
    criticalReferences: [],
    nextIntent: "Continue the deterministic workload.",
  });
}

class OneStepPerReadAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly mainRequests: ApiAdapterStreamInput[] = [];
  readonly requestBytes: number[] = [];
  summaryCalls = 0;
  private mainTurn = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    /*
     * A compaction request is not a Step. It carries `toolChoice: NONE` and may still carry the Run's
     * tools as a cacheable replay prefix, so "has tools" is not the test — counting one as a model turn
     * would silently shift every later Step by one and make the ordered-history assertion meaningless.
     */
    if ((input.request.tools?.length ?? 0) === 0 || input.request.toolChoice?.type === "NONE") {
      this.summaryCalls += 1;
      return this.summary();
    }
    this.mainTurn += 1;
    this.mainRequests.push(input);
    this.requestBytes.push(Buffer.byteLength(JSON.stringify(input.request.messages), "utf8"));
    return this.turn(this.mainTurn);
  }

  private async *summary(): AsyncGenerator<AIAdapterEvent> {
    yield* answer(summaryText());
  }

  private async *turn(index: number): AsyncGenerator<AIAdapterEvent> {
    if (index === 1) {
      yield* toolCall("long-plan", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "long-run",
            step: "Read the durable evidence one line at a time.",
            status: "in_progress",
            acceptance: ["Every read is closed and the Run reaches a final answer."],
          },
        ],
        execution: {
          goal: "Cross a long single user turn under the daemon's own Context policy.",
          constraints: ["History stays ordered and no Tool result is lost."],
          discoveries: [],
          decisions: [],
          unresolved: [],
          nextAction: "Read the next evidence block.",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    if (index < STEPS) {
      /*
       * A different 40-line window every Step, cycling every hundred Steps.
       *
       * Repeating one exact call is not a healthy long Run — the progress projection would classify it
       * as a repeated pattern, and a lease is only renewed at a healthy boundary, so a Run that reads
       * the same line seventy times legitimately never renews. Varying the window is what makes this
       * an *infrastructure* measurement instead of a measurement of the loop detector.
       */
      yield* toolCall("long-run-read-" + String(index), "read_file", {
        path: "evidence.txt",
        offset: (((index - 2) * 3) % 300) + 1,
        limit: 40,
      });
      yield finish("TOOL_CALLS");
      return;
    }
    yield* answer("The long Run completed on a bounded request.");
  }
}

function makeEvidence(): string {
  return Array.from(
    { length: 400 },
    (_, index) =>
      "LONG_RUN_EVIDENCE_" +
      String(index).padStart(3, "0") +
      " " +
      "durable observation ".repeat(5),
  ).join("\n");
}

const fixtures: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of fixtures.splice(0)) await dispose();
});

interface EpochRow {
  readonly epoch_id: string;
  readonly reset_reason: string;
  readonly created_step_sequence: number;
}

describe(`long-run context acceptance (${String(STEPS)} steps, ${POLICY} policy)`, () => {
  it("keeps the epoch chain, the Tool order and the request bound for the whole Run", async () => {
    const adapter = new OneStepPerReadAdapter();
    const fixture = await createReliabilityFixture({
      adapter,
      limits: { maxSteps: STEPS + 10, maxToolCalls: STEPS + 20, timeoutMs: 900_000 },
      resourcePolicy: RESOURCE_POLICY,
      modelLimits: MODEL_LIMITS,
      contextBudgetPolicy:
        POLICY === "default" ? "DAEMON_DEFAULT" : { version: "LEGACY_FULL_OUTPUT_V1" },
    });
    fixtures.push(() => fixture.dispose());
    await writeFile(join(fixture.workspacePath, "evidence.txt"), makeEvidence(), "utf8");

    /*
     * The policy assertion comes first, and it is the one that makes the rest meaningful: if the
     * fixture had silently fallen back to a legacy policy, every bound below would describe a
     * different product than the one a user gets.
     */
    let headroom:
      { readonly expectedGrowthTokens: number; readonly preferredOutputTokens: number } | undefined;
    if (POLICY === "default") {
      /*
       * The production default no longer carries a working set. It freezes the headroom algorithm and
       * its parameters; the output allowance and the preparation trigger are derived per turn from
       * the input that is actually prepared.
       */
      expect(fixture.run.contextBudgetPolicy.version).toBe("TURN_BUDGET_V3");
      if (fixture.run.contextBudgetPolicy.version !== "TURN_BUDGET_V3") return;
      expect(fixture.run.contextBudgetPolicy.algorithm).toBe("HEADROOM_V1");
      expect(fixture.run.contextBudgetPolicy.preferredOutputTokens).toBe(8_192);
      expect(fixture.run.contextBudgetPolicy.expectedGrowthTokens).toBeGreaterThan(0);
      expect(
        (fixture.run.contextBudgetPolicy as { readonly workingSet?: unknown }).workingSet,
      ).toBeUndefined();
      headroom = fixture.run.contextBudgetPolicy;
    } else {
      expect(fixture.run.contextBudgetPolicy).toEqual({ version: "LEGACY_FULL_OUTPUT_V1" });
    }

    const result = await fixture.composition.controller.start(fixture.run.id);
    const records = await fixture.storage.messageRecords.listByRun(fixture.run.id);
    const checkpoints = await fixture.storage.contextCheckpointsV2.listByRun(fixture.run.id);
    const governance = await fixture.storage.resourceGovernance.get(fixture.run.id);
    const toolResults = records.filter((record) => record.messageType === "TOOL_RESULT");
    const requestedCallIds = records
      .filter((record) => record.messageType === "ASSISTANT")
      .flatMap((record) => {
        const content = record.data.content;
        if (!Array.isArray(content)) return [];
        return content.flatMap((part) => {
          if (
            typeof part !== "object" ||
            part === null ||
            !("type" in part) ||
            part.type !== "TOOL_CALL" ||
            !("toolCallId" in part) ||
            typeof part.toolCallId !== "string"
          ) {
            return [];
          }
          return [part.toolCallId];
        });
      });
    const resultCallIds = toolResults.map((record) => record.data.toolCallId);

    if (result.run.status !== "COMPLETED") {
      const state = await fixture.storage.runStates.get(fixture.run.id);
      console.info(
        JSON.stringify({
          scenario: "long-run-matrix",
          steps: STEPS,
          policy: POLICY,
          status: result.run.status,
          requests: adapter.mainRequests.length,
          errors: state?.errors,
        }),
      );
    }
    expect(result.run.status).toBe("COMPLETED");
    expect(adapter.mainRequests.length).toBe(STEPS);

    // Every request but the first is answered by one read; the last is the final answer.
    expect(toolResults).toHaveLength(STEPS - 1);
    expect(toolResults.every((record) => record.data.isError === false)).toBe(true);
    // Nothing was dropped or reordered: the results arrive in the order the calls were made.
    expect(resultCallIds).toEqual(requestedCallIds);

    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    let epochs: EpochRow[];
    let recordsPerEpoch: number[];
    try {
      epochs = database
        .prepare(
          "SELECT epoch_id, reset_reason, created_step_sequence FROM prompt_surface_epochs WHERE run_id = ? ORDER BY created_step_sequence ASC, rowid ASC",
        )
        .all(fixture.run.id) as unknown as EpochRow[];
      recordsPerEpoch = epochs.map((epoch) => {
        const rows = database
          .prepare(
            "SELECT kind, ordinal FROM prompt_surface_records WHERE run_id = ? AND epoch_id = ? ORDER BY ordinal ASC",
          )
          .all(fixture.run.id, epoch.epoch_id) as unknown as Array<{
          kind: string;
          ordinal: number;
        }>;
        // Every epoch opens with its own baseline; a rollover re-baselines, it does not continue.
        expect(rows[0]).toEqual({ kind: "BASELINE", ordinal: 1 });
        return rows.length;
      });
    } finally {
      database.close();
    }

    // One epoch at least, opened at the first Step, and every later epoch created strictly after.
    expect(epochs.length).toBeGreaterThanOrEqual(1);
    expect(epochs[0]!.reset_reason).toBe("INITIAL");
    for (let index = 1; index < epochs.length; index += 1) {
      expect(epochs[index]!.created_step_sequence).toBeGreaterThan(
        epochs[index - 1]!.created_step_sequence,
      );
      expect(epochs[index]!.reset_reason).not.toBe("INITIAL");
    }

    const rollovers = epochs.filter((epoch) => epoch.reset_reason === "CAPACITY_ROLLOVER");
    const compactions = epochs.filter((epoch) => epoch.reset_reason === "COMPACTION_COMMITTED");

    if (POLICY === "legacy") {
      /*
       * Under the legacy policy nothing is ever compacted, so the only thing that can keep a long
       * Run's replay bounded is the capacity rollover. The closed epoch must still hold exactly the
       * decisions it made — one per Step up to the Step that triggered the rollover.
       */
      expect(compactions).toHaveLength(0);
      expect(adapter.summaryCalls).toBe(0);
      expect(rollovers.length).toBeGreaterThanOrEqual(1);
      expect(recordsPerEpoch[0]).toBe(rollovers[0]!.created_step_sequence - 1);
      expect(rollovers[0]!.created_step_sequence).toBeLessThan(129);
    } else {
      /*
       * Under the headroom policy this Run is nowhere near its window: a million-token model and a
       * few hundred small reads. The correct behaviour is therefore *not* to reorganize history —
       * and this is the assertion that would have failed for three years of the old default, which
       * compacted at roughly 72 000 tokens no matter how much room it had.
       *
       * The 128-record Surface boundary still rolls over, because that bound is structural and has
       * nothing to do with capacity.
       */
      expect(checkpoints).toHaveLength(0);
      expect(compactions).toHaveLength(0);
      expect(adapter.summaryCalls).toBe(0);
      expect(rollovers.length).toBeGreaterThanOrEqual(1);
      expect(rollovers[0]!.created_step_sequence).toBeLessThan(129);
    }

    /*
     * What a request costs, read two different ways because the two policies bound different things.
     *
     * The default policy caps the *request*: compaction fires at `targetTokens × triggerRatio`, so no
     * request may pass that budget by more than the Step that crossed it. The legacy policy caps
     * nothing about the conversation — its only bound is the epoch's replay budget, which is why the
     * rollover assertion above is the whole of its guarantee here and a byte bound would be a number
     * the product never promised.
     */
    const firstBytes = adapter.requestBytes[0]!;
    const largestBytes = Math.max(...adapter.requestBytes);
    expect(firstBytes).toBeGreaterThan(0);
    if (headroom !== undefined) {
      /*
       * The bound is the window, and it is checked against the durable per-turn decision rather than
       * against a byte heuristic: the last turn's `inputTokens + outputAllowanceTokens + safetyTokens`
       * must fit its `windowTokens`, and its remaining room must cover the growth it expects.
       */
      expect(largestBytes).toBeLessThanOrEqual(
        MODEL_LIMITS.contextWindowTokens * UTF8_BYTES_PER_TOKEN,
      );
      const decisionDb = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        const row = decisionDb
          .prepare("SELECT breakdown_json FROM context_runtime_states WHERE run_id=?")
          .get(fixture.run.id) as { breakdown_json: string } | undefined;
        expect(row).toBeDefined();
        const decision = (
          JSON.parse(row!.breakdown_json) as {
            readonly turnBudget?: {
              readonly version: string;
              readonly windowTokens: number;
              readonly inputTokens: number;
              readonly outputAllowanceTokens: number;
              readonly safetyTokens: number;
              readonly remainingTokens: number;
              readonly expectedGrowthTokens: number;
              readonly decision: string;
            };
          }
        ).turnBudget;
        expect(decision).toBeDefined();
        expect(decision!.version).toBe("TURN_BUDGET_DECISION_V1");
        expect(decision!.windowTokens).toBe(MODEL_LIMITS.contextWindowTokens);
        expect(decision!.outputAllowanceTokens).toBe(headroom.preferredOutputTokens);
        expect(
          decision!.inputTokens + decision!.outputAllowanceTokens + decision!.safetyTokens,
        ).toBeLessThanOrEqual(decision!.windowTokens);
        expect(decision!.decision).toBe("KEEP");
        expect(decision!.remainingTokens).toBeGreaterThanOrEqual(decision!.expectedGrowthTokens);
      } finally {
        decisionDb.close();
      }
    } else {
      expect(largestBytes).toBeGreaterThanOrEqual(firstBytes);
    }

    // A long Run renews its lease rather than being paused by its own first one.
    expect(governance?.leaseEpoch ?? 0).toBeGreaterThan(1);

    const metrics = {
      scenario: "long-run-matrix",
      layer: "INFRASTRUCTURE_CAPACITY",
      proves: `the production composition survives ${String(STEPS)} Steps under the ${POLICY} policy`,
      doesNotProve: "that a model chooses its next action from the feedback it was given",
      steps: STEPS,
      policy: POLICY,
      contextBudgetPolicyVersion: fixture.run.contextBudgetPolicy.version,
      mainModelRequests: adapter.mainRequests.length,
      compactionCalls: adapter.summaryCalls,
      checkpoints: checkpoints.length,
      epochs: epochs.length,
      resetReasons: epochs.map((epoch) => epoch.reset_reason),
      recordsPerEpoch,
      leaseEpoch: governance?.leaseEpoch,
      firstRequestBytes: firstBytes,
      largestRequestBytes: largestBytes,
      lastRequestBytes: adapter.requestBytes.at(-1),
    };
    console.info(JSON.stringify(metrics));
    const metricsPath = process.env["CAELUSH_RELIABILITY_METRICS_PATH"];
    if (metricsPath !== undefined) {
      await writeFile(metricsPath, JSON.stringify(metrics, null, 2) + "\n", "utf8");
    }
  }, 1_800_000);
});
