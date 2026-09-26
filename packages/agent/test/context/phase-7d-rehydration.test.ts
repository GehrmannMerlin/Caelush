import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  createContextDocumentBuilder,
  createContextItem,
  createContextItemId,
  createContextPlanner,
  createContextPolicy,
  createContextRehydrator,
  createContextSourceId,
  createStructuredCheckpoint,
  type ContextAuthoritySnapshot,
} from "@caelush/agent";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7d-rehydration" },
  api: "test-api",
  limits: { contextWindowTokens: 100, maxOutputTokens: 10 },
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

const checkpoint = createStructuredCheckpoint({
  version: 1,
  goal: "old goal from recovery",
  constraints: [],
  completedWork: [],
  inProgress: [],
  blocked: [],
  importantDiscoveries: [],
  keyDecisions: [],
  changedFiles: ["old.ts"],
  readFiles: [],
  recentErrors: [],
  verificationState: "failed",
  activeProcesses: ["old-process"],
  pendingApprovals: ["old-approval"],
  resourceGovernance: "old-governance",
  criticalReferences: [],
  nextIntent: "recover",
  sourceRange: { from: 1, to: 2 },
});

const authorities: ContextAuthoritySnapshot = {
  goal: "current goal",
  changedFiles: [],
  pendingApprovals: [],
  activeProcesses: [],
  verificationState: "passed",
  resourceGovernance: "current-governance",
  projectFacts: [],
};

describe("Phase 7D authority rehydration", () => {
  it("lets current authority override recovery, including explicit empty collections", async () => {
    const state = await createContextRehydrator().rehydrate({
      checkpoint,
      authorities,
    });

    expect(state).toEqual({
      goal: "current goal",
      changedFiles: [],
      pendingApprovals: [],
      activeProcesses: [],
      verificationState: "passed",
      resourceGovernance: "current-governance",
      projectFacts: [],
      checkpoint,
    });
  });

  it("falls back only for undefined authority fields and returns immutable state", async () => {
    const state = await createContextRehydrator().rehydrate({
      checkpoint,
      authorities: { goal: "current goal", verificationState: "passed" },
    });

    expect(state.changedFiles).toEqual(["old.ts"]);
    expect(state.pendingApprovals).toEqual(["old-approval"]);
    expect(state.activeProcesses).toEqual(["old-process"]);
    expect(state.projectFacts).toEqual([]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.changedFiles)).toBe(true);
    expect(Object.isFrozen(state.checkpoint)).toBe(true);
  });

  it("renders current authority separately from recovery summary", async () => {
    const item = createContextItem({
      id: createContextItemId("checkpoint:recovery"),
      type: "agent.checkpoint",
      source: {
        providerId: createContextSourceId("agent.checkpoint"),
        sourceRef: "checkpoint:recovery",
        version: "v2",
      },
      scope: "RUN",
      retention: "REHYDRATABLE",
      priorityClass: "HIGH",
      tokenEstimate: 10,
      cacheStability: "STABLE",
      freshness: "CURRENT",
      sensitivity: "INTERNAL",
      whyLoaded: "recovery",
      payload: { kind: "CHECKPOINT", checkpoint },
    });
    const plan = createContextPlanner().plan({
      items: [item],
      policy: createContextPolicy({
        model: MODEL,
        requestOverhead: { toolSchemaTokens: 0, protocolOverheadTokens: 0, totalTokens: 0 },
        options: { outputReserveTokens: 1, safetyReserveTokens: 1 },
      }),
    });
    const state = await createContextRehydrator().rehydrate({ checkpoint, authorities });
    const document = createContextDocumentBuilder().build({ plan, rehydrated: state });

    const current = document.sections.filter((section) =>
      section.sourceRef.startsWith("authority:current:"),
    );
    const recovery = document.sections.find((section) => section.authority === "RECOVERY_RECORD");
    expect(current.some((section) => section.text.includes("AUTHORITATIVE CURRENT STATE"))).toBe(
      true,
    );
    expect(current.some((section) => section.text.includes("passed"))).toBe(true);
    expect(recovery?.text).toContain("RECOVERY SUMMARY");
    expect(recovery?.text).toContain("failed");
  });
});
