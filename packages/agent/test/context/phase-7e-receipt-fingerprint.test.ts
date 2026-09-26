import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import { createRunId, createSessionId } from "@caelush/protocol";
import {
  createContextItem,
  createContextPolicy,
  createContextReceiptBuilder,
  type ContextPlan,
  type ContextSourceResult,
} from "@caelush/agent";

const RUN_ID = createRunId("run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a");
const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7e" },
  api: "test-api",
  limits: { contextWindowTokens: 1000, maxOutputTokens: 100 },
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

function buildFacts(sourceVersion = "v1", tools = [{ name: "read", description: "Read", inputSchema: {} }]) {
  const item = createContextItem({
    id: "item:secret" as never,
    type: "coding.relevant_file",
    source: { providerId: "coding.relevant-files" as never, sourceRef: "src/app.ts", version: sourceVersion },
    scope: "RUN",
    retention: "RECENT",
    priorityClass: "NORMAL",
    tokenEstimate: 10,
    cacheStability: "SEMI_STABLE",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    whyLoaded: "test",
    payload: { kind: "TEXT", text: "sk-test-secret-DO-NOT-LEAK full source content" },
  });
  const policy = createContextPolicy({
    model: MODEL,
    tools,
    options: { outputReserveTokens: 100, safetyReserveTokens: 10 },
  });
  const plan: ContextPlan = {
    selectedItems: [item],
    decisions: [{ itemId: item.id, disposition: "SELECTED", reason: "PRIORITY", tokenEstimate: 10 }],
    budget: {
      contextWindowTokens: 1000,
      outputReserveTokens: 100,
      safetyReserveTokens: 10,
      requestOverheadTokens: policy.requestOverhead.totalTokens,
      effectiveInputLimitTokens: policy.effectiveInputLimitTokens,
      mandatoryTokens: 0,
      selectedTokens: 10,
      remainingTokens: policy.effectiveInputLimitTokens - 10,
    },
    pressure: "NORMAL",
    requiresCompaction: false,
  };
  const sourceResults: readonly ContextSourceResult[] = [
    {
      providerId: "coding.relevant-files" as never,
      providerVersion: sourceVersion,
      items: [item],
      diagnostics: [],
    },
  ];
  return {
    identity: { runId: RUN_ID, sessionId: createSessionId(), goal: "test" },
    turn: { stepId: "stp_phase_7e" as never, sequence: 1 },
    mode: "NORMAL" as const,
    model: MODEL,
    tools,
    policy,
    sourceResults,
    plan,
    conversationMessages: [],
    materializedMessages: [{ role: "system", content: "bounded" }],
  };
}

describe("Phase 7E receipt and fingerprint builder", () => {
  it("projects real source decisions and never copies selected raw content", () => {
    const facts = buildFacts();
    const built = createContextReceiptBuilder({ now: () => 1234 as never }).build(facts);

    expect(built.receipt.sources[0]).toMatchObject({
      providerVersion: "v1",
      selectedItemIds: ["item:secret"],
      droppedItemIds: [],
      deferredItemIds: [],
    });
    expect(built.report.requestOverheadTokens).toBe(facts.policy.requestOverhead.totalTokens);
    expect(built.receipt.toolSchemaTokens).toBe(facts.policy.requestOverhead.toolSchemaTokens);
    expect(JSON.stringify(built.receipt)).not.toContain("sk-test-secret-DO-NOT-LEAK");
    expect(JSON.stringify(built.report)).not.toContain("full source content");
    expect(JSON.stringify(built.usage)).not.toContain("sk-test-secret-DO-NOT-LEAK");
    expect(built.receipt.contextFingerprint).toBe(built.usage.contextFingerprint);
  });

  it("is stable for irrelevant metadata but changes for source and tool schema drift", () => {
    const first = createContextReceiptBuilder({ now: () => 1234 as never }).build(buildFacts());
    const same = createContextReceiptBuilder({ now: () => 9999 as never }).build(buildFacts());
    const sourceDrift = createContextReceiptBuilder({ now: () => 1234 as never }).build(buildFacts("v2"));
    const toolDrift = createContextReceiptBuilder({ now: () => 1234 as never }).build(
      buildFacts("v1", [{ name: "write", description: "Write", inputSchema: { type: "object" } }]),
    );

    expect(same.receipt.contextFingerprint).toBe(first.receipt.contextFingerprint);
    expect(sourceDrift.receipt.contextFingerprint).not.toBe(first.receipt.contextFingerprint);
    expect(toolDrift.receipt.contextFingerprint).not.toBe(first.receipt.contextFingerprint);
    expect(toolDrift.receipt.toolSchemaTokens).not.toBe(first.receipt.toolSchemaTokens);
  });
});
