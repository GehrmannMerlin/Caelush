import { describe, expect, it } from "vitest";

import { createRunId, createSessionId } from "@caelush/protocol";
import {
  createContextMessageRange,
  createContextSummaryPromptVersion,
  createContextSummarizationRunner,
  createStructuredCheckpoint,
  serializeContextSummarySource,
  type AgentExecutionIdentity,
  type ContextAuthoritySnapshot,
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

const authorities: ContextAuthoritySnapshot = {
  goal: identity.goal,
  changedFiles: ["packages/agent/src/context"],
  pendingApprovals: [],
  activeProcesses: [],
  verificationState: "not-run",
  resourceGovernance: "bounded",
  projectFacts: ["local-first"],
};

function checkpoint(overrides: Partial<Parameters<typeof createStructuredCheckpoint>[0]> = {}) {
  return createStructuredCheckpoint({
    version: 1,
    goal: identity.goal,
    constraints: [],
    completedWork: [],
    inProgress: ["semantic compaction"],
    blocked: [],
    importantDiscoveries: [],
    keyDecisions: [],
    changedFiles: [],
    readFiles: [],
    recentErrors: [],
    verificationState: "not-run",
    activeProcesses: [],
    pendingApprovals: [],
    resourceGovernance: "bounded",
    criticalReferences: [],
    nextIntent: "Continue from the checkpoint.",
    sourceRange: { from: 1, to: 3 },
    ...overrides,
  });
}

function input(): ContextSummarizationInput {
  return {
    identity,
    reason: "PROACTIVE_PRESSURE",
    sourceMessages,
    sourceRange,
    authorities,
    targetTokens: 60,
    model: MODEL,
  };
}

function successfulSummarizer(): ContextSummarizerPort {
  return {
    async summarize() {
      return {
        checkpoint: checkpoint({ nextIntent: "Continue with verification." }),
        modelRef: MODEL.ref,
        summaryPromptVersion: createContextSummaryPromptVersion(1),
        sourceDigest: "ignored-by-runner",
        checkpointDigest: "ignored-by-runner",
      };
    },
  };
}

describe("Phase 7D semantic summarization", () => {
  it("serializes bounded semantic source without raw Tool output or credentials", () => {
    const serialized = serializeContextSummarySource(input());

    expect(serialized).toContain("TOOL_RESULT");
    expect(serialized).toContain("tool_0");
    expect(serialized).not.toContain("FULL_ARTIFACT_BODY");
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
    expect(first.result.sourceDigest).toBe(second.result.sourceDigest);
    expect(first.result.checkpointDigest).toBe(second.result.checkpointDigest);
    expect(first.result.sourceDigest).not.toBe("ignored-by-runner");
    expect(first.result.checkpointDigest).not.toBe("ignored-by-runner");
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
    expect(result.degraded).toBe(true);
    expect(result.result.checkpoint.goal).toBe(identity.goal);
    expect(result.result.checkpoint.sourceRange).toEqual({ from: 1, to: 3 });
    expect(result.result.checkpoint.changedFiles).toEqual(authorities.changedFiles);
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
