import { describe, expect, it } from "vitest";

import { createRunId, createSessionId } from "@caelush/protocol";
import {
  createContextMessageRange,
  createContextSummarizationRunner,
  createSemanticCheckpointDraft,
  serializeContextSummarySource,
  type AgentExecutionIdentity,
  type ContextSummarizationInput,
  type ContextSummarizerPort,
} from "@caelush/agent";
import type { ModelDescriptor } from "@caelush/ai";
import { agentMessageId, conversationTurnId } from "@caelush/agent";

import { assistantMessage, toolResultMessage, userMessage } from "../messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7d-summary" },
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

const sourceMessages = [
  userMessage({ sequence: 1, text: "Use password=super-secret to inspect the project." }),
  assistantMessage({ sequence: 2, text: "I will inspect the project.", toolCalls: ["call_1"] }),
  toolResultMessage({
    sequence: 3,
    projectedContent: "FULL_ARTIFACT_BODY password=super-secret Bearer abc123",
  }),
] as const;

const sourceRange = createContextMessageRange({
  runId: identity.runId,
  conversationTurnId: conversationTurnId("cturn_phase_7d_summary"),
  firstMessageId: agentMessageId("amsg_phase_7d_summary_first"),
  lastMessageId: agentMessageId("amsg_phase_7d_summary_last"),
  firstSequence: 1,
  lastSequence: 3,
});

function semantic(overrides: Partial<Parameters<typeof createSemanticCheckpointDraft>[0]> = {}) {
  return createSemanticCheckpointDraft({
    goal: identity.goal,
    constraints: [],
    completedWork: [],
    inProgress: ["semantic compaction"],
    blocked: [],
    importantDiscoveries: [],
    keyDecisions: [],
    criticalReferences: [],
    nextIntent: "Continue from the checkpoint.",
    ...overrides,
  });
}

function input(): ContextSummarizationInput {
  return {
    purpose: "COMPACTION",
    cacheEligibility: "NOT_ELIGIBLE",
    identity,
    reason: "PROACTIVE_PRESSURE",
    sourceMessages,
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

function successfulSummarizer(): ContextSummarizerPort {
  return {
    async summarize() {
      return {
        semantic: semantic({ nextIntent: "Continue with verification." }),
        modelRef: MODEL.ref,
        finishReason: "STOP",
        summaryPromptVersion: 3,
        sourceDigest: "ignored-by-runner",
        semanticDigest: "ignored-by-runner",
      };
    },
  };
}

describe("Phase 7D semantic summarization", () => {
  it("serializes projected Tool feedback without credentials", () => {
    const serialized = serializeContextSummarySource(input());

    expect(serialized).toContain("TOOL_RESULT");
    expect(serialized).toContain("tool_0");
    expect(serialized).toContain("FULL_ARTIFACT_BODY password=[REDACTED] Bearer [REDACTED]");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("Bearer abc123");
    expect(serialized.length).toBeLessThanOrEqual(24_000);
    expect(serializeContextSummarySource(input())).toBe(serialized);
  });

  it("makes exactly one semantic attempt and computes stable source/checkpoint digests", async () => {
    let calls = 0;
    const summarizer: ContextSummarizerPort = {
      async summarize(received) {
        calls += 1;
        expect(received.sourceMessages).toBe(sourceMessages);
        return await successfulSummarizer().summarize(received, {
          signal: new AbortController().signal,
        });
      },
    };
    const runner = createContextSummarizationRunner({ summarizer });

    const first = await runner.summarize(input(), { signal: new AbortController().signal });
    const second = await runner.summarize(input(), { signal: new AbortController().signal });

    expect(calls).toBe(2);
    expect(first.degraded).toBe(false);
    expect(first.kind).toBe("ACCEPTED");
    expect(second.kind).toBe("ACCEPTED");
    if (first.kind !== "ACCEPTED" || second.kind !== "ACCEPTED")
      throw new Error("expected accepted");
    expect(first.result.sourceDigest).toBe(second.result.sourceDigest);
    expect(first.result.semanticDigest).toBe(second.result.semanticDigest);
    expect(first.result.sourceDigest).not.toBe("ignored-by-runner");
    expect(first.result.semanticDigest).not.toBe("ignored-by-runner");
  });

  it("uses a deterministic minimal checkpoint after one non-cancellation failure", async () => {
    let calls = 0;
    const summarizer: ContextSummarizerPort = {
      async summarize() {
        calls += 1;
        throw new Error("provider unavailable");
      },
    };
    const runner = createContextSummarizationRunner({ summarizer });
    const result = await runner.summarize(input(), { signal: new AbortController().signal });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      kind: "FALLBACK_REQUIRED",
      degraded: true,
      outcome: "FAILED",
      summaryPromptVersion: 3,
    });
  });

  it("propagates cancellation and never creates a fallback checkpoint", async () => {
    let calls = 0;
    const controller = new AbortController();
    const summarizer: ContextSummarizerPort = {
      async summarize() {
        calls += 1;
        controller.abort();
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      },
    };
    const runner = createContextSummarizationRunner({ summarizer });

    await expect(runner.summarize(input(), { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toBe(1);
  });
});
