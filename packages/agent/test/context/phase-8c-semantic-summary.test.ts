import { describe, expect, it } from "vitest";

import { createRunId, createSessionId } from "@caelush/protocol";
import type { ModelDescriptor } from "@caelush/ai";
import {
  createContextMessageRange,
  createContextSummaryReplayPrefixFingerprint,
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
    purpose: "COMPACTION",
    cacheEligibility: "NOT_ELIGIBLE",
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
    summaryPromptVersion: 3,
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
    let observedPurpose: unknown;
    let observedCacheEligibility: unknown;
    const summarizer: ContextSummarizerPort = {
      async summarize(request) {
        calls += 1;
        observedPurpose = (request as ContextSummarizationInput & { purpose?: unknown }).purpose;
        observedCacheEligibility = (
          request as ContextSummarizationInput & { cacheEligibility?: unknown }
        ).cacheEligibility;
        throw new Error("provider unavailable");
      },
    };

    const execution = await createContextSummarizationRunner({ summarizer }).summarize(input(), {
      signal: new AbortController().signal,
    });

    expect(calls).toBe(1);
    expect(observedPurpose).toBe("COMPACTION");
    expect(observedCacheEligibility).toBe("NOT_ELIGIBLE");
    expect(execution).toMatchObject({
      kind: "FALLBACK_REQUIRED",
      outcome: "FAILED",
      degraded: true,
      summaryPromptVersion: 3,
    });
    expect(execution).not.toHaveProperty("result");
    if (execution.kind !== "FALLBACK_REQUIRED") throw new Error("expected fallback");
    expect(execution.sourceDigest).not.toBe("gateway-summary-source");
  });

  it("downgrades a requested warm replay when its prefix is incomplete", async () => {
    let observedEligibility: unknown;
    let observedFingerprint: unknown;
    const summarizer: ContextSummarizerPort = {
      async summarize(request) {
        observedEligibility = (
          request as ContextSummarizationInput & { cacheEligibility?: unknown }
        ).cacheEligibility;
        observedFingerprint = (
          request as ContextSummarizationInput & { replayPrefixFingerprint?: unknown }
        ).replayPrefixFingerprint;
        return result();
      },
    };
    const incomplete = {
      ...input(),
      purpose: "COMPACTION",
      cacheEligibility: "CACHE_REUSE_ELIGIBLE",
      replayPrefixFingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } as unknown as ContextSummarizationInput;

    const execution = await createContextSummarizationRunner({ summarizer }).summarize(incomplete, {
      signal: new AbortController().signal,
    });

    expect(execution.kind).toBe("ACCEPTED");
    expect(observedEligibility).toBe("NOT_ELIGIBLE");
    expect(observedFingerprint).toBeUndefined();
  });

  it("downgrades a changed-model or malformed claimed replay and still attempts the summary", async () => {
    const prefix = {
      modelRef: { ...MODEL.ref, model: "different-model" },
      api: MODEL.api,
      surfaceFingerprint: `sha256:${"b".repeat(64)}`,
      messages: [{ role: "system" as const, content: "Stable host context." }],
      tools: [],
    };
    const changedModel = {
      ...input(),
      cacheEligibility: "CACHE_REUSE_ELIGIBLE",
      replayPrefix: prefix,
      replayPrefixFingerprint: createContextSummaryReplayPrefixFingerprint(prefix),
    } satisfies ContextSummarizationInput;
    const malformed = {
      ...input(),
      cacheEligibility: "CACHE_REUSE_ELIGIBLE",
      replayPrefixFingerprint: `sha256:${"c".repeat(64)}`,
      replayPrefix: {
        modelRef: MODEL.ref,
        api: MODEL.api,
        surfaceFingerprint: `sha256:${"b".repeat(64)}`,
        tools: [],
      },
    } as unknown as ContextSummarizationInput;
    const observed: Array<{
      readonly eligibility: unknown;
      readonly fingerprint: unknown;
    }> = [];
    const summarizer: ContextSummarizerPort = {
      async summarize(request) {
        observed.push({
          eligibility: request.cacheEligibility,
          fingerprint: request.replayPrefixFingerprint,
        });
        return result();
      },
    };
    const runner = createContextSummarizationRunner({ summarizer });

    const changedModelResult = await runner.summarize(changedModel, {
      signal: new AbortController().signal,
    });
    const malformedResult = await runner.summarize(malformed, {
      signal: new AbortController().signal,
    });

    expect(changedModelResult.kind).toBe("ACCEPTED");
    expect(malformedResult.kind).toBe("ACCEPTED");
    expect(observed).toEqual([
      { eligibility: "NOT_ELIGIBLE", fingerprint: undefined },
      { eligibility: "NOT_ELIGIBLE", fingerprint: undefined },
    ]);
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
