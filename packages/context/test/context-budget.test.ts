import type { LLMSystemMessage, LLMUserMessage } from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import { ContextBudgetExceededError } from "../src/errors.js";
import { assembleContextBudget } from "../src/context-budget.js";
import type { ConversationTurnGroup } from "../src/conversation-history.js";
import type { RelevantFileContextSection } from "../src/relevant-file-plan.js";
import type { ContextBuildLimits } from "../src/context-builder.js";
import { createContextPolicy } from "../src/context-policy.js";
import { createModelContextProfile } from "../src/model-context-profile.js";

const estimator = { estimateText: (text: string) => text.length };
const limits = (maxInputTokens: number, overrides: Partial<ContextBuildLimits> = {}) => ({
  maxInputTokens,
  safetyMarginTokens: 0,
  maxConversationTokens: 1000,
  maxRelevantFileTokens: 1000,
  minRelevantFileTokens: 1,
  ...overrides,
});
const system: LLMSystemMessage = { role: "system", content: "s" };
const current: LLMUserMessage = { role: "user", content: "u" };
const group = (content: string): ConversationTurnGroup => ({
  messages: [{ role: "user", content }],
  estimatedTokens: JSON.stringify({ role: "user", content }).length,
});
const file = (content: string, relativePath = "src/file.ts"): RelevantFileContextSection => ({
  provenance: {
    kind: "PROJECT_FILE",
    path: `/repo/${relativePath}`,
    relativePath,
    score: 10,
    reasons: [],
  },
  content,
  estimatedTokens: content.length,
  bytesIncluded: Buffer.byteLength(content, "utf8"),
  truncated: false,
});

describe("final context budget", () => {
  it("rejects invalid policy ratios and unsafe caps instead of creating an unusable budget", () => {
    const profile = createModelContextProfile({
      providerId: "fixture",
      modelId: "policy",
      contextWindowTokens: 16_000,
      maxOutputTokens: 2_048,
      recommendedOutputReserveTokens: 2_048,
      supportsPromptCaching: false,
      supportsUsageReporting: false,
    });

    expect(() => createContextPolicy(profile, { targetRecentTailRatio: 1 })).toThrow(RangeError);
    expect(() =>
      createContextPolicy(profile, { maxObservationBatchTokensCap: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(RangeError);
  });

  it("subtracts output and safety reserves once on the policy path", () => {
    const profile = createModelContextProfile({
      providerId: "fixture",
      modelId: "arithmetic",
      contextWindowTokens: 16_000,
      maxOutputTokens: 2_048,
      recommendedOutputReserveTokens: 2_048,
      supportsPromptCaching: false,
      supportsUsageReporting: false,
    });
    const policy = createContextPolicy(profile, { safetyReserveTokens: 512 });

    expect(policy.effectiveInputLimit).toBe(13_440);
    expect(
      policy.effectiveInputLimit + policy.outputReserveTokens + policy.safetyReserveTokens,
    ).toBe(profile.contextWindowTokens);
  });

  it("fails closed when mandatory rendered messages plus safety exceed the budget", () => {
    expect(() =>
      assembleContextBudget({
        system,
        current,
        groups: [],
        files: [],
        limits: limits(2, { safetyMarginTokens: 1 }),
        estimator,
      }),
    ).toThrow(ContextBudgetExceededError);
  });

  it("uses integer 40/60 optional allocation and keeps final rendered budget", () => {
    const result = assembleContextBudget({
      system,
      current,
      groups: [group("history")],
      files: [file("content", "src/a.ts")],
      limits: limits(100),
      estimator,
    });
    expect(result.messages[0]).toEqual(system);
    expect(result.messages.at(-1)).toEqual(current);
    expect(result.conversationTarget).toBe(16);
    expect(result.fileTarget).toBe(24);
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(100);
  });

  it("transfers unused conversation capacity to files and keeps file provenance", () => {
    const result = assembleContextBudget({
      system,
      current,
      groups: [],
      files: [file("a".repeat(30)), file("b".repeat(30), "src/b.ts")],
      limits: limits(500),
      estimator,
    });
    expect(result.messages.some((message) => message.role === "user" && message !== current)).toBe(
      true,
    );
    expect(result.relevantFiles.selectedFiles).toBeGreaterThan(0);
  });

  it("further truncates a final file only when the useful threshold remains", () => {
    const result = assembleContextBudget({
      system,
      current,
      groups: [],
      files: [file("0123456789".repeat(30), "src/large.ts")],
      limits: limits(400, { minRelevantFileTokens: 3 }),
      estimator,
    });
    expect(result.relevantFiles.selectedFiles).toBe(1);
    expect(result.relevantFiles.furtherTruncatedFiles).toBe(1);
    const fileMessage = result.messages.find(
      (message) => message.role === "user" && message !== current,
    );
    expect(fileMessage?.content).toContain('truncated="true"');
  });

  it("drops optional content before violating the hard final invariant", () => {
    const result = assembleContextBudget({
      system: { role: "system", content: "s".repeat(20) },
      current,
      groups: [group("history")],
      files: [file("file")],
      limits: limits(120),
      estimator,
    });
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(120);
    expect(result.estimatedInputTokens + result.safetyMarginTokens).toBeLessThanOrEqual(120);
  });
});
