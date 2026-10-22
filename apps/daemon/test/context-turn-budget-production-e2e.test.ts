import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createReliabilityFixture } from "./support/reliability-fixture.js";

/**
 * M2 / B13–B14: the production turn budget.
 *
 * ```text
 * a new Run            TURN_BUDGET_V3, HEADROOM_V1, no working set, no 96 000/72 000 pair
 * the wire             maxOutputTokens === the allowance the Context budgeted
 * a 1M window at 8%    no history reorganization, remaining room far above the growth
 * ```
 *
 * The assertion is made against the pinned SDK's real request body and against the durable usage
 * row, not against a helper's return value: a budget that only agrees with itself proves nothing
 * about what the provider was asked for.
 */

const API = "openai-compatible-chat";
const MEGA_WINDOW = 1_048_576;
const MODEL_MAX_OUTPUT = 65_536;

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chunk",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function sseText(text: string): Response {
  return new Response(chunk({ content: text }) + chunk({}, "stop") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

interface WireBudget {
  readonly maxOutputTokens: number | undefined;
  readonly messageCount: number;
}

interface PersistedDecision {
  readonly version: string;
  readonly algorithm: string;
  readonly windowTokens: number;
  readonly inputTokens: number;
  readonly outputAllowanceTokens: number;
  readonly safetyTokens: number;
  readonly expectedGrowthTokens: number;
  readonly remainingTokens: number;
  readonly decision: string;
}

function readDecision(databasePath: string, runId: string): PersistedDecision {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT breakdown_json, compaction_count FROM context_runtime_states WHERE run_id=?")
      .get(runId) as { breakdown_json: string; compaction_count: number } | undefined;
    if (row === undefined) throw new Error("no context usage row was written");
    const envelope = JSON.parse(row.breakdown_json) as { turnBudget?: PersistedDecision };
    if (envelope.turnBudget === undefined) throw new Error("no turn budget decision was persisted");
    return envelope.turnBudget;
  } finally {
    db.close();
  }
}

describe("M2 — production turn budget under HEADROOM_V1", () => {
  it("freezes HEADROOM_V1 for a new Run and keeps the wire allowance equal to the decision", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "caelush-turn-budget-"));
    const wires: WireBudget[] = [];
    const fixture = await createReliabilityFixture({
      rootDirectory,
      api: API,
      useBuiltinAdapter: true,
      providerBindingOverrides: {
        defaultApi: API,
        endpoint: "http://127.0.0.1:1/offline",
        transport: {
          fetch: async (_url: unknown, init: { readonly body?: unknown }) => {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            const maxOutputTokens =
              body["max_tokens"] ?? body["max_completion_tokens"] ?? body["maxOutputTokens"];
            wires.push({
              maxOutputTokens:
                typeof maxOutputTokens === "number" ? maxOutputTokens : undefined,
              messageCount: Array.isArray(body["messages"]) ? body["messages"].length : 0,
            });
            return sseText("The workspace contains a probe file.");
          },
        },
      },
      modelLimits: { contextWindowTokens: MEGA_WINDOW, maxOutputTokens: MODEL_MAX_OUTPUT },
      // The daemon's own resolver, not a hand-written object: this is the authority `createRun` uses.
      contextBudgetPolicy: "DAEMON_DEFAULT",
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 60_000 },
    });
    try {
      // A new Run must not be frozen against the retired fixed working set.
      expect(fixture.run.contextBudgetPolicy?.version).toBe("TURN_BUDGET_V3");
      const policy = fixture.run.contextBudgetPolicy as {
        readonly algorithm: string;
        readonly preferredOutputTokens: number;
        readonly minOutputTokens: number;
        readonly expectedGrowthTokens: number;
        readonly workingSet?: unknown;
      };
      expect(policy.algorithm).toBe("HEADROOM_V1");
      expect(policy.workingSet).toBeUndefined();
      expect(policy.preferredOutputTokens).toBe(16_384);
      expect(policy.minOutputTokens).toBe(2_048);

      const end = await fixture.composition.controller.start(fixture.run.id);
      expect(end.run.status).toBe("COMPLETED");

      expect(wires).toHaveLength(1);
      const wire = wires[0]!;
      const decision = readDecision(fixture.databasePath, fixture.run.id);

      expect(decision.version).toBe("TURN_BUDGET_DECISION_V1");
      expect(decision.algorithm).toBe("HEADROOM_V1");
      expect(decision.windowTokens).toBe(MEGA_WINDOW);
      // The whole point: the wire carries the budgeted allowance, not the model's full capability.
      expect(wire.maxOutputTokens).toBe(decision.outputAllowanceTokens);
      expect(wire.maxOutputTokens).toBe(policy.preferredOutputTokens);
      expect(wire.maxOutputTokens).toBeLessThan(MODEL_MAX_OUTPUT);

      // P + O + S <= W, stated by the persisted decision itself.
      expect(decision.remainingTokens).toBe(
        decision.windowTokens -
          decision.inputTokens -
          decision.outputAllowanceTokens -
          decision.safetyTokens,
      );
      expect(decision.remainingTokens).toBeGreaterThanOrEqual(0);

      // ~8% of a 1M window: no reorganization, and room left over for the next turn's growth.
      expect(decision.inputTokens).toBeLessThan(Math.floor(MEGA_WINDOW * 0.08));
      expect(decision.decision).toBe("KEEP");
      expect(decision.remainingTokens).toBeGreaterThan(decision.expectedGrowthTokens);

      const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        const compactions = (
          db
            .prepare("SELECT compaction_count AS n FROM context_runtime_states WHERE run_id=?")
            .get(fixture.run.id) as { n: number }
        ).n;
        expect(compactions).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  }, 90_000);
});
