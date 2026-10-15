import {
  AgentRunSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { RunController } from "../src/run-controller.js";
import type { RunBudgetPort } from "../src/budget-ports.js";
import { completionStoreOver } from "./support/completion-store.js";
import {
  fakeContextEngine,
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { MemoryRunStore } from "./support/phase-3d-tool-turn.js";
import { testRunMessageAuthority } from "./support/run-message-authority.js";

describe("RunController overflow recovery budget", () => {
  it("re-admits the rebuilt request with the original admitted output ceiling", async () => {
    const run = AgentRunSchema.parse({
      id: createRunId(),
      sessionId: createSessionId(),
      goal: "recover one model turn",
      status: "PENDING",
      workspace: { id: createWorkspaceId(), path: "/repo" },
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "fixture" },
      permissionProfile: "READ_ONLY",
      approvalPolicy: "ALWAYS_ASK",
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1_000, maxTokens: 100_000 },
      createdAt: createTimestampMs(1),
    });
    const store = new MemoryRunStore({ run, conversationRecords: [] });
    const stepId = createStepId();
    const executor = fakeFrozenModelTurnExecutor((_request, _signal, callIndex) =>
      callIndex === 0
        ? {
            kind: "FAILED",
            error: { code: "CONTEXT_OVERFLOW", message: "too large", retryable: false },
          }
        : {
            kind: "FAILED",
            error: { code: "PROVIDER_ERROR", message: "stop after recovery", retryable: false },
          },
    );
    const baseContextEngine = fakeContextEngine();
    const contextEngine = {
      preparations: baseContextEngine.preparations,
      prepare: async (input: Parameters<typeof baseContextEngine.prepare>[0]) => ({
        ...(await baseContextEngine.prepare(input)),
        requestBudget: {
          version: "LEGACY_FULL_OUTPUT_V1" as const,
          outputReserveTokens: 8_192,
          safetyReserveTokens: 0,
        },
      }),
    };
    const execution = testRunAgentExecution({
      executor,
      contextEngine,
      createStepId: () => stepId,
    });
    const recoveryAdmissions: Array<Parameters<NonNullable<RunBudgetPort["admitLLMRecovery"]>>[0]> =
      [];
    let estimates = 0;
    const budget: RunBudgetPort = {
      async admitLLM() {
        return { kind: "ALLOWED", effectiveMaxOutputTokens: 64 };
      },
      async admitLLMRecovery(input) {
        recoveryAdmissions.push(input);
        return { kind: "ALLOWED", effectiveMaxOutputTokens: 32 };
      },
      async settleLLM() {
        return { kind: "SETTLED" };
      },
    };
    const controller = new RunController({
      agentExecution: execution.factory,
      executionStore: store,
      completionStore: completionStoreOver(store),
      messages: testRunMessageAuthority({ snapshot: () => store.snapshot }),
      events: { notifyCommitted: () => undefined, emitTransient: () => undefined },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "base",
          contextLimits: { maxInputTokens: 1_000 },
        }),
      },
      clock: { now: () => createTimestampMs(20) },
      eventIdFactory: { create: () => createEventId() },
      budget,
      tokenEstimator: {
        estimate: () => (estimates++ === 0 ? 120 : 40),
      },
    });

    await controller.start(run.id);

    expect(recoveryAdmissions).toHaveLength(1);
    expect(recoveryAdmissions[0]).toMatchObject({
      step: { id: stepId },
      admission: { estimatedInputTokens: 40 },
      initialOutputCeiling: 64,
    });
    expect(executor.callCount()).toBe(2);
    expect(executor.requests[1]?.settings?.maxOutputTokens).toBe(32);
  });
});
