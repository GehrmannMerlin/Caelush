import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventId, createStepId, createTimestampMs, type RunId } from "@caelush/protocol";
import { RunController } from "@caelush/core";
import { describe, expect, it } from "vitest";
import { openCaelushStorage, type CaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeStep, makeState } from "./support/fixtures.js";
import { EventBus } from "./support/test-event-notifier.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { testRunMessageAuthority } from "../../core/test/support/run-message-authority.js";

async function withDatabase(
  prefix: string,
  body: (open: () => Promise<CaelushStorage>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const opened: CaelushStorage[] = [];
  try {
    await body(async () => {
      const storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
      opened.push(storage);
      return storage;
    });
  } finally {
    for (const storage of opened) await storage.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function seedCancelledRun(storage: CaelushStorage) {
  const session = makeSession();
  const run = makeRun(session.id, {
    status: "CANCELLED",
    startedAt: createTimestampMs(2),
    finishedAt: createTimestampMs(3),
  });
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  await storage.runStates.save(
    makeState(run, {
      startedAt: createTimestampMs(2),
      updatedAt: createTimestampMs(3),
    }),
  );
  return run;
}

async function reserveInFlightLLMAttempt(
  storage: CaelushStorage,
  runId: ReturnType<typeof makeRun>["id"],
  ownerId: ReturnType<typeof createStepId>,
) {
  await storage.budgetLedger.reserve({
    id: `llm-attempt:${ownerId}`,
    runId,
    kind: "LLM_ATTEMPT",
    ownerId,
    reservedInputTokens: 21,
    reservedOutputTokens: 34,
    reservedCostMicros: 55,
    createdAt: createTimestampMs(10),
  });
  await storage.budgetLedger.markInFlight(runId, "LLM_ATTEMPT", ownerId, createTimestampMs(11));
}

function controllerOver(
  storage: CaelushStorage,
  providerCalls: { count: number },
  beforeLoad?: (runId: RunId) => Promise<void>,
): RunController {
  const executionStore =
    beforeLoad === undefined
      ? storage.execution
      : new Proxy(storage.execution, {
          get(target, property) {
            if (property === "load") {
              return async (runId: RunId) => {
                await beforeLoad(runId);
                return target.load(runId);
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
  return new RunController({
    agentExecution: testRunAgentExecution({
      executor: fakeFrozenModelTurnExecutor(() => {
        providerCalls.count += 1;
        return {
          kind: "FAILED",
          error: {
            code: "PROVIDER_ERROR",
            message: "This terminal recovery test must not call a Provider.",
            retryable: false,
          },
        };
      }),
    }).factory,
    executionStore,
    messages: testRunMessageAuthority({
      records: (runId) => storage.messageRecords.listByRun(runId),
    }),
    events: new EventBus(storage.eventReader),
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "unused",
        contextLimits: { maxInputTokens: 1_000 },
      }),
    },
    clock: { now: () => createTimestampMs(100) },
    eventIdFactory: { create: createEventId },
    budget: storage.budget,
  });
}

describe("RunBudgetPort recovery of unopened LLM reservations", () => {
  it("settles missing-Step reservations to zero, keeps durable-Step entries conservative, and is idempotent", async () => {
    await withDatabase("caelush-budget-unopened-recovery-", async (open) => {
      const first = await open();
      const run = await seedCancelledRun(first);
      const orphanOwner = createStepId();
      const durableStep = makeStep(run.id, { id: createStepId() });
      await first.steps.insert(durableStep);
      await reserveInFlightLLMAttempt(first, run.id, orphanOwner);
      await reserveInFlightLLMAttempt(first, run.id, durableStep.id);
      await first.budgetLedger.reserve({
        id: "tool-invocation:restart",
        runId: run.id,
        kind: "TOOL_INVOCATION",
        ownerId: "invocation-restart",
        reservedToolCalls: 1,
        createdAt: createTimestampMs(10),
      });
      await first.budgetLedger.markInFlight(
        run.id,
        "TOOL_INVOCATION",
        "invocation-restart",
        createTimestampMs(11),
      );
      await first.close();

      const recovered = await open();
      const settledAt = createTimestampMs(20);
      await recovered.budget.recover(run.id, settledAt);

      await expect(
        recovered.budgetLedger.get(run.id, "LLM_ATTEMPT", orphanOwner),
      ).resolves.toMatchObject({
        state: "SETTLED",
        actualInputTokens: 0,
        actualOutputTokens: 0,
        actualCostMicros: 0,
        settledAt,
      });
      await expect(
        recovered.budgetLedger.get(run.id, "LLM_ATTEMPT", durableStep.id),
      ).resolves.toMatchObject({
        state: "CONSERVATIVE",
        settledAt,
      });
      await expect(
        recovered.budgetLedger.get(run.id, "TOOL_INVOCATION", "invocation-restart"),
      ).resolves.toMatchObject({
        state: "CONSERVATIVE",
        settledAt,
      });
      await expect(recovered.budgetLedger.snapshot(run.id)).resolves.toMatchObject({
        tokensConsumed: 55,
        tokensReserved: 0,
        toolCallsConsumed: 1,
        toolCallsReserved: 0,
      });

      await recovered.budget.recover(run.id, createTimestampMs(30));
      await expect(
        recovered.budgetLedger.get(run.id, "LLM_ATTEMPT", orphanOwner),
      ).resolves.toMatchObject({ state: "SETTLED", settledAt });
      await expect(
        recovered.budgetLedger.get(run.id, "LLM_ATTEMPT", durableStep.id),
      ).resolves.toMatchObject({ state: "CONSERVATIVE", settledAt });
    });
  });

  it("runs orphan recovery before RunController loads and routes a restarted Run", async () => {
    await withDatabase("caelush-budget-unopened-controller-", async (open) => {
      const first = await open();
      const run = await seedCancelledRun(first);
      const orphanOwner = createStepId();
      await reserveInFlightLLMAttempt(first, run.id, orphanOwner);
      await first.close();

      const recovered = await open();
      const providerCalls = { count: 0 };
      let stateAtFirstLoad: string | undefined;
      const result = await controllerOver(recovered, providerCalls, async (runId) => {
        stateAtFirstLoad = (await recovered.budgetLedger.get(runId, "LLM_ATTEMPT", orphanOwner))
          ?.state;
      }).recover(run.id);

      expect(result.status).toBe("TERMINAL");
      expect(providerCalls.count).toBe(0);
      expect(stateAtFirstLoad).toBe("SETTLED");
      await expect(
        recovered.budgetLedger.get(run.id, "LLM_ATTEMPT", orphanOwner),
      ).resolves.toMatchObject({
        state: "SETTLED",
        actualInputTokens: 0,
        actualOutputTokens: 0,
      });
    });
  });
});
