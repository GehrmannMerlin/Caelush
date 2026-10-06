import { describe, expect, it } from "vitest";

import type { AIMessage, AIGateway, AIModelTurnResult } from "@caelush/ai";
import {
  agentMessageId,
  conversationTurnId,
  createContextMessageRange,
  createContextSummaryReplayPrefixFingerprint,
  type AgentExecutionIdentity,
  type ContextSummarizationInput,
} from "@caelush/agent";
import { createRunId, createSessionId, createTimestampMs, type AgentRun } from "@caelush/protocol";

import {
  ContextCompactionBudgetDeniedError,
  type ContextCompactionBudgetPort,
  createBudgetedContextSummarizer,
} from "../src/context/context-compaction-composition.js";

const identity: AgentExecutionIdentity = {
  runId: createRunId("run_phase_8e_budget"),
  sessionId: createSessionId("session_phase_8e_budget"),
  goal: "Budget the summary.",
};

const run = {
  id: identity.runId,
  sessionId: identity.sessionId,
  goal: identity.goal,
  status: "RUNNING",
  workspace: { id: "workspace_phase_8e", path: "C:/workspace" },
  model: { provider: "test", model: "budget-model" },
  runtime: { id: "local", kind: "test" },
  permissionProfile: "READ_ONLY",
  approvalPolicy: "ALWAYS_ASK",
  limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 1000, maxTokens: 10_000 },
  createdAt: createTimestampMs(100),
} as AgentRun;

const model = {
  ref: { provider: "test", model: "budget-model" },
  api: "test-api",
  limits: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
} as const;

const input: ContextSummarizationInput = {
  purpose: "COMPACTION",
  cacheEligibility: "NOT_ELIGIBLE",
  identity,
  reason: "PROACTIVE_PRESSURE",
  sourceMessages: [],
  sourceRange: createContextMessageRange({
    runId: identity.runId,
    conversationTurnId: conversationTurnId("turn_phase_8e_budget"),
    firstMessageId: agentMessageId("first_phase_8e_budget"),
    lastMessageId: agentMessageId("last_phase_8e_budget"),
    firstSequence: 1,
    lastSequence: 2,
  }),
  cut: {
    kind: "TURN_BOUNDARY",
    firstKeptTurnId: conversationTurnId("turn_phase_8e_budget"),
    firstKeptMessageId: agentMessageId("last_phase_8e_budget"),
    firstKeptSequence: 3,
  },
  targetTokens: 100,
  model,
};

const result: AIModelTurnResult = {
  callId: "call_phase_8e_budget" as AIModelTurnResult["callId"],
  providerId: "test" as AIModelTurnResult["providerId"],
  model: model.ref,
  text: JSON.stringify({
    goal: "Budget the summary.",
    constraints: [],
    completedWork: [],
    inProgress: [],
    blocked: [],
    importantDiscoveries: [],
    keyDecisions: [],
    criticalReferences: [],
    nextIntent: "Continue",
  }),
  toolCalls: [],
  finishReason: "STOP",
  usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
  resolution: {} as AIModelTurnResult["resolution"],
};

function gatewayThat(
  behavior: (request: Parameters<AIGateway["complete"]>[0]) => Promise<AIModelTurnResult>,
) {
  const requests: Array<Parameters<AIGateway["complete"]>[0]> = [];
  return {
    requests,
    gateway: {
      async complete(request: Parameters<AIGateway["complete"]>[0]) {
        requests.push(request);
        return behavior(request);
      },
      async stream() {
        throw new Error("stream is not used");
      },
    } satisfies AIGateway,
  };
}

function budgetFixture(overrides: Partial<ContextCompactionBudgetPort> = {}) {
  const calls = { admit: 0, settle: 0, conservative: 0 };
  const owners: string[] = [];
  const budget: ContextCompactionBudgetPort = {
    async admitContextCompactionLLM(input) {
      calls.admit += 1;
      owners.push(input.ownerId);
      return { kind: "ALLOWED", effectiveMaxOutputTokens: 40 };
    },
    async settleContextCompactionLLM() {
      calls.settle += 1;
      return { kind: "SETTLED" };
    },
    async markContextCompactionLLMConservative() {
      calls.conservative += 1;
    },
    ...overrides,
  };
  return { budget, calls, owners };
}

describe("Phase 8E budgeted Context summarizer", () => {
  it("admits before provider I/O, clamps output, and settles actual usage", async () => {
    const fixture = gatewayThat(async () => result);
    const budget = budgetFixture();
    const summarizer = createBudgetedContextSummarizer({
      gateway: fixture.gateway,
      budget: budget.budget,
      run,
      clock: { now: () => createTimestampMs(101) },
    });

    await summarizer.summarize(input, { signal: new AbortController().signal });

    expect(budget.calls.admit).toBe(1);
    expect(fixture.requests[0]?.settings?.maxOutputTokens).toBe(40);
    expect(budget.calls.settle).toBe(1);
    expect(budget.calls.conservative).toBe(0);
  });

  it("does not call the provider when the auxiliary admission is denied", async () => {
    const fixture = gatewayThat(async () => result);
    const budget = budgetFixture({
      async admitContextCompactionLLM() {
        return { kind: "EXCEEDED", dimension: "TOKENS", accounted: 10, limit: 10 };
      },
    });
    const summarizer = createBudgetedContextSummarizer({
      gateway: fixture.gateway,
      budget: budget.budget,
      run,
      clock: { now: () => createTimestampMs(101) },
    });

    await expect(
      summarizer.summarize(input, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(ContextCompactionBudgetDeniedError);
    expect(fixture.requests).toHaveLength(0);
  });

  it("conservatively closes an admitted owner when provider I/O fails", async () => {
    const fixture = gatewayThat(async () => {
      throw new Error("provider failed");
    });
    const budget = budgetFixture();
    const summarizer = createBudgetedContextSummarizer({
      gateway: fixture.gateway,
      budget: budget.budget,
      run,
      clock: { now: () => createTimestampMs(101) },
    });

    await expect(
      summarizer.summarize(input, { signal: new AbortController().signal }),
    ).rejects.toThrow("provider failed");
    expect(budget.calls.conservative).toBe(1);
    expect(budget.calls.settle).toBe(0);
  });

  it("reuses the same bounded owner for an identical replay and separates a changed prefix", async () => {
    const fixture = gatewayThat(async () => result);
    const budget = budgetFixture();
    const summarizer = createBudgetedContextSummarizer({
      gateway: fixture.gateway,
      budget: budget.budget,
      run,
      clock: { now: () => createTimestampMs(101) },
    });
    const makeReplayInput = (systemText: string): ContextSummarizationInput => {
      const messages: readonly AIMessage[] = [
        { role: "system", content: systemText },
        { role: "user", content: "Current durable request." },
      ];
      const replayPrefix = {
        modelRef: model.ref,
        api: model.api,
        surfaceFingerprint: `sha256:${"c".repeat(64)}`,
        messages,
        tools: [],
      };
      return {
        ...input,
        cacheEligibility: "CACHE_REUSE_ELIGIBLE",
        replayPrefix,
        replayPrefixFingerprint: createContextSummaryReplayPrefixFingerprint(replayPrefix),
      };
    };

    await summarizer.summarize(makeReplayInput("Stable host context."), {
      signal: new AbortController().signal,
    });
    await summarizer.summarize(makeReplayInput("Stable host context."), {
      signal: new AbortController().signal,
    });
    await summarizer.summarize(makeReplayInput("Changed host context."), {
      signal: new AbortController().signal,
    });

    expect(budget.owners).toHaveLength(3);
    expect(budget.owners[0]).toBe(budget.owners[1]);
    expect(budget.owners[2]).not.toBe(budget.owners[0]);
  });
});
