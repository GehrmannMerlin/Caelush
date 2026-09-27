import { describe, expect, it } from "vitest";

import { createRunId, createSessionId } from "@caelush/protocol";
import type { ModelDescriptor } from "@caelush/ai";
import {
  createContextMessageRange,
  createContextSummarizationRunner,
  createSemanticCheckpointDraft,
  createSemanticSummaryValidator,
  SemanticSummaryMalformedError,
  type AgentExecutionIdentity,
  type ContextSummarizationInput,
  type ContextSummarizationResult,
  type ContextSummarizerPort,
  type SemanticCheckpointDraft,
} from "@caelush/agent";
import { agentMessageId, conversationTurnId } from "@caelush/agent";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-8c-summary" },
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
};

const identity: AgentExecutionIdentity = {
  runId: createRunId(),
  sessionId: createSessionId(),
  goal: "Preserve the execution story.",
};

const sourceRange = createContextMessageRange({
  runId: identity.runId,
  conversationTurnId: conversationTurnId("cturn_phase_8c_summary"),
  firstMessageId: agentMessageId("amsg_phase_8c_first"),
  lastMessageId: agentMessageId("amsg_phase_8c_last"),
  firstSequence: 1,
  lastSequence: 3,
});

const semantic = createSemanticCheckpointDraft({
  goal: identity.goal,
  constraints: ["Keep Tool protocol intact."],
  completedWork: ["Separated semantic memory from durable facts."],
  inProgress: ["Implementing Phase 8C."],
  blocked: [],
  importantDiscoveries: ["Summary is recovery memory."],
  keyDecisions: ["Authority decides current verification."],
  criticalReferences: ["source:1-3"],
  nextIntent: "Collect current facts.",
});

function input(): ContextSummarizationInput {
  return {
    identity,
    reason: "PROACTIVE_PRESSURE",
    sourceMessages: [],
    sourceRange,
    cut: {
      kind: "TURN_BOUNDARY",
      firstKeptTurnId: sourceRange.conversationTurnId,
      firstKeptMessageId: sourceRange.lastMessageId,
      firstKeptSequence: sourceRange.lastSequence + 1,
    },
    targetTokens: 60,
    model: MODEL,
  };
}

function result(overrides: Partial<ContextSummarizationResult> = {}): ContextSummarizationResult {
  return {
    semantic,
    modelRef: MODEL.ref,
    finishReason: "STOP",
    summaryPromptVersion: 2,
    sourceDigest: "ignored-source-digest",
    semanticDigest: "ignored-semantic-digest",
    ...overrides,
  };
}

describe("Phase 8C semantic summary contracts", () => {
  it("accepts the exact semantic draft shape and deeply freezes it", () => {
    expect(Object.isFrozen(semantic)).toBe(true);
    expect(Object.isFrozen(semantic.constraints)).toBe(true);
    expect(() => (semantic.constraints as string[]).push("mutate")).toThrow();
  });

  it("rejects authority, record, and range fields at the semantic boundary", () => {
    expect(() =>
      createSemanticCheckpointDraft({
        ...semantic,
        verificationState: "PASSED",
      } as unknown as SemanticCheckpointDraft),
    ).toThrow(/unknown|semantic/i);
    expect(() =>
      createSemanticCheckpointDraft({
        ...semantic,
        nextIntent: undefined,
      } as unknown as SemanticCheckpointDraft),
    ).toThrow(/nextIntent|semantic/i);
  });

  it("maps finish reasons and validates STOP semantic JSON", () => {
    const validator = createSemanticSummaryValidator();

    expect(validator.validate({ result: result() })).toMatchObject({ outcome: "ACCEPTED" });
    expect(validator.validate({ result: result({ finishReason: "LENGTH" }) })).toMatchObject({
      outcome: "TRUNCATED",
    });
    expect(
      validator.validate({ result: result({ finishReason: "CONTENT_FILTER" }) }),
    ).toMatchObject({
      outcome: "FILTERED",
    });
    expect(validator.validate({ result: result({ finishReason: "TOOL_CALLS" }) })).toMatchObject({
      outcome: "FAILED",
    });
    expect(validator.validate({ result: result({ finishReason: "OTHER" }) })).toMatchObject({
      outcome: "FAILED",
    });
  });

  it("makes one semantic attempt, computes owned digests, and classifies provider failure", async () => {
    let calls = 0;
    const summarizer: ContextSummarizerPort = {
      async summarize() {
        calls += 1;
        throw new Error("provider unavailable");
      },
    };

    const execution = await createContextSummarizationRunner({ summarizer }).summarize(input(), {
      signal: new AbortController().signal,
    });

    expect(calls).toBe(1);
    expect(execution).toMatchObject({
      kind: "FALLBACK_REQUIRED",
      outcome: "FAILED",
      degraded: true,
      summaryPromptVersion: 2,
    });
    expect(execution).not.toHaveProperty("result");
    if (execution.kind !== "FALLBACK_REQUIRED") throw new Error("expected fallback");
    expect(execution.sourceDigest).not.toBe("gateway-summary-source");
  });

  it("classifies typed malformed provider output separately from infrastructure failure", async () => {
    const execution = await createContextSummarizationRunner({
      summarizer: {
        async summarize() {
          throw new SemanticSummaryMalformedError();
        },
      },
    }).summarize(input(), { signal: new AbortController().signal });

    expect(execution).toMatchObject({
      kind: "FALLBACK_REQUIRED",
      outcome: "MALFORMED",
      degraded: true,
    });
  });

  it("propagates cancellation instead of manufacturing fallback success", async () => {
    const controller = new AbortController();
    const summarizer: ContextSummarizerPort = {
      async summarize() {
        controller.abort();
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      },
    };

    await expect(
      createContextSummarizationRunner({ summarizer }).summarize(input(), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
