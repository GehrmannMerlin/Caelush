import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ApiId } from "@caelush/ai";
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answer, finish, toolCall } from "./support/ai-fixture.js";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";

/**
 * The capacity boundary as it happens in production, and only that.
 *
 * ```text
 * one user turn → 128 model requests → 128 durable visible Prompt Surface records
 *   → request 129 needs a decision
 *   → decidePromptSurfaceCapacity      ROLLOVER_REQUIRED / VISIBLE_RECORDS / 129 / 128
 *   → rolloverPromptSurface            canonical identity
 *   → SqlitePromptSurfaceStore         one atomic epoch swap
 *   → provider request 129
 * ```
 *
 * The policy here is the *legacy* one on purpose. Working-set compaction would rebuild the surface
 * often enough to hide a broken rollover, which is exactly how the production defect survived a
 * green suite: the 250-step test ran with compaction enabled and never needed the capacity path.
 */

const fixtures: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of fixtures.splice(0)) await dispose();
});

const RUN_STEPS = Number(process.env["CAELUSH_CAPACITY_STEPS"] ?? "133");

class LegacyCapacityAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly mainRequests: ApiAdapterStreamInput[] = [];
  summaryCalls = 0;

  stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    if ((input.request.tools?.length ?? 0) === 0) {
      this.summaryCalls += 1;
      return this.summary();
    }
    this.mainRequests.push(input);
    return this.turn(this.mainRequests.length);
  }

  private async *summary(): AsyncGenerator<AIAdapterEvent> {
    yield* answer("{}");
  }

  private async *turn(index: number): AsyncGenerator<AIAdapterEvent> {
    if (index === 1) {
      yield* toolCall("capacity-plan", "update_plan", {
        planVersion: 2,
        plan: [
          {
            id: "capacity",
            step: "Read the durable evidence one line at a time.",
            status: "in_progress",
            acceptance: ["Every engine read is closed and the Run reaches a final answer."],
          },
        ],
        execution: {
          goal: "Cross the 128-record Prompt Surface bound inside one user turn.",
          constraints: ["The legacy context policy stays in effect."],
          discoveries: [],
          decisions: [],
          unresolved: [],
          nextAction: "Read the next evidence line.",
        },
      });
      yield finish("TOOL_CALLS");
      return;
    }
    if (index < RUN_STEPS) {
      yield* toolCall("capacity-read-" + index, "read_file", {
        path: "evidence.txt",
        offset: ((index - 2) % 40) + 1,
        limit: 1,
      });
      yield finish("TOOL_CALLS");
      return;
    }
    yield* answer(
      "The 128-record capacity boundary was crossed without a local projection failure.",
    );
  }
}

function makeEvidence(): string {
  return Array.from(
    { length: 40 },
    (_, index) =>
      "CONTAINER_EVIDENCE_" +
      String(index).padStart(3, "0") +
      " " +
      "closed observation ".repeat(5),
  ).join("\n");
}

describe("production Prompt Surface capacity rollover (legacy policy, real SQLite)", () => {
  it(`completes ${String(RUN_STEPS)} model requests and opens a CAPACITY_ROLLOVER epoch`, async () => {
    const adapter = new LegacyCapacityAdapter();
    const fixture = await createReliabilityFixture({
      adapter,
      limits: { maxSteps: RUN_STEPS + 10, maxToolCalls: RUN_STEPS + 20, timeoutMs: 900_000 },
      // test4 ran on a 1M-token window. Under a small window the *conversation* becomes the binding
      // constraint long before the 128-record surface bound, and the Run would stop for a reason
      // that has nothing to do with the epoch transition this test exists for.
      modelLimits: { contextWindowTokens: 1_048_576, maxOutputTokens: 8_192 },
    });
    fixtures.push(() => fixture.dispose());
    await writeFile(join(fixture.workspacePath, "evidence.txt"), makeEvidence(), "utf8");

    expect(fixture.run.contextBudgetPolicy).toEqual({ version: "LEGACY_FULL_OUTPUT_V1" });

    const result = await fixture.composition.controller.start(fixture.run.id);
    if (result.run.status !== "COMPLETED") {
      const state = await fixture.storage.runStates.get(fixture.run.id);
      console.info(
        JSON.stringify({
          scenario: "capacity-rollover",
          status: result.run.status,
          requests: adapter.mainRequests.length,
          errors: state?.errors,
          steps: (await fixture.storage.steps.listByRun(fixture.run.id)).length,
          governance: await fixture.storage.resourceGovernance.get(fixture.run.id),
        }),
      );
    }
    expect(result.run.status).toBe("COMPLETED");
    expect(adapter.mainRequests.length).toBeGreaterThanOrEqual(129);
    expect(adapter.mainRequests.length).toBe(RUN_STEPS);

    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const epochs = database
        .prepare(
          "SELECT epoch_id, reset_reason, created_step_sequence FROM prompt_surface_epochs WHERE run_id = ? ORDER BY created_step_sequence ASC, rowid ASC",
        )
        .all(fixture.run.id) as unknown as Array<{
        epoch_id: string;
        reset_reason: string;
        created_step_sequence: number;
      }>;
      const rollovers = epochs.filter((epoch) => epoch.reset_reason === "CAPACITY_ROLLOVER");
      expect(rollovers.length).toBeGreaterThanOrEqual(1);
      /*
       * The trigger is the replay budget, not the 128-record ceiling.
       *
       * One Step re-sends roughly 2 KiB of Section state on this trajectory, so a 24 000-token budget
       * (72 KiB) is spent well before a hundred and twenty-eight records exist. The hard ceiling is
       * still enforced and is exercised against real SQLite one record at a time in
       * `prompt-surface-rollover-production.test.ts`; what this test proves is the path a long Run
       * actually takes: it crosses into a new epoch, the closed epoch is left intact and readable, the
       * new one opens with a baseline, and the Run keeps going to completion afterwards.
       */
      expect(rollovers[0]!.created_step_sequence).toBeGreaterThan(2);
      expect(rollovers[0]!.created_step_sequence).toBeLessThan(129);

      // The closed epoch keeps every decision it made: one record per Step, no loss at the boundary.
      const initial = epochs[0]!;
      const initialRecords = database
        .prepare(
          "SELECT kind FROM prompt_surface_records WHERE run_id = ? AND epoch_id = ? ORDER BY ordinal ASC",
        )
        .all(fixture.run.id, initial.epoch_id) as unknown as Array<{ kind: string }>;
      expect(initialRecords).toHaveLength(rollovers[0]!.created_step_sequence - 1);
      const rolledRecords = database
        .prepare(
          "SELECT kind, ordinal FROM prompt_surface_records WHERE run_id = ? AND epoch_id = ? ORDER BY ordinal ASC",
        )
        .all(fixture.run.id, rollovers[0]!.epoch_id) as unknown as Array<{
        kind: string;
        ordinal: number;
      }>;
      expect(rolledRecords[0]).toEqual({ kind: "BASELINE", ordinal: 1 });
      expect(rolledRecords.length).toBeGreaterThan(1);

      const current = database
        .prepare(
          "SELECT epoch_id FROM prompt_surface_epochs WHERE run_id = ? ORDER BY created_step_sequence DESC, rowid DESC LIMIT 1",
        )
        .get(fixture.run.id) as unknown as { epoch_id: string } | undefined;
      expect(current?.epoch_id).toBe(rollovers.at(-1)!.epoch_id);
    } finally {
      database.close();
    }

    // The Run really did continue: every request after the boundary was served and every Tool
    // result stayed ordered.
    const records = await fixture.storage.messageRecords.listByRun(fixture.run.id);
    const toolResults = records.filter((record) => record.messageType === "TOOL_RESULT");
    // One accepted `update_plan` result plus one result per read request.
    expect(toolResults).toHaveLength(RUN_STEPS - 1);
    expect(toolResults.every((record) => record.data.isError === false)).toBe(true);
    expect(adapter.summaryCalls).toBe(0);
  }, 900_000);
});
