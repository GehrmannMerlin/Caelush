import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  createContextDocumentBuilder,
  createContextFingerprint,
  createContextItem,
  createContextItemId,
  createContextMaterializer,
  createContextPlanner,
  createContextPolicy,
  createContextSourceId,
  createStandardAgentMessageProjectorRegistry,
  createUtf8HeuristicTokenEstimator,
  createPromptSurfaceEpoch,
  createPromptSurfaceSnapshot,
  type PreparedAgentContext,
} from "@caelush/agent";

import { assistantMessage, userMessage } from "../messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "prefix-characterization" },
  api: "fixture-chat",
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

const TOOL_CATALOG = Object.freeze([
  Object.freeze({
    name: "read_file",
    description: "Read a workspace file.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({ path: Object.freeze({ type: "string" }) }),
    }),
  }),
]);

const MODEL_SETTINGS = Object.freeze({
  temperature: 0.2,
  maxOutputTokens: 1_000,
  reasoning: "MEDIUM",
});

function prepared(workCommentaries: readonly string[]): PreparedAgentContext {
  const instruction = createContextItem({
    id: createContextItemId("reference:stable-instruction"),
    type: "coding.project_instruction",
    source: {
      providerId: createContextSourceId("coding.project-instructions"),
      sourceRef: "project-instructions",
      version: "v1",
    },
    scope: "PROJECT",
    retention: "PINNED",
    priorityClass: "HIGH",
    tokenEstimate: 4,
    cacheStability: "STABLE",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    whyLoaded: "stable project instruction",
    payload: { kind: "TEXT", text: "Use the established project conventions." },
  });
  const commentary = createContextItem({
    id: createContextItemId("commentary:work-status"),
    type: "agent.extension-contribution",
    source: {
      providerId: createContextSourceId("agent.extension-contributions"),
      sourceRef: "hook/work-commentary",
      version: "v1",
    },
    scope: "TURN",
    retention: "EPHEMERAL",
    priorityClass: "HIGH",
    tokenEstimate: 6,
    cacheStability: "DYNAMIC",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    whyLoaded: "current work commentary",
    payload: { kind: "TEXT", text: workCommentaries.at(-1) ?? "" },
  });
  const policy = createContextPolicy({
    model: MODEL,
    requestOverhead: { toolSchemaTokens: 0, protocolOverheadTokens: 0, totalTokens: 0 },
    options: { outputReserveTokens: 1, safetyReserveTokens: 1 },
  });
  const plan = createContextPlanner().plan({ items: [instruction, commentary], policy });
  const document = createContextDocumentBuilder().build({
    plan,
    rehydrated: {
      goal: "Inspect the current workspace state.",
      changedFiles: [],
      pendingApprovals: [],
      activeProcesses: [],
      verificationState: "not-run",
      resourceGovernance: "bounded",
      projectFacts: [],
    },
  });
  const fingerprint = createContextFingerprint("sha256:prefix-characterization");
  const firstUser = userMessage({ sequence: 1, text: "Summarize the current state." });
  const conversationMessages =
    workCommentaries.length === 1
      ? [firstUser]
      : [
          firstUser,
          assistantMessage({ sequence: 2, text: "Previous state summary." }),
          userMessage({ sequence: 3, text: "Continue with the updated state." }),
        ];
  const runId = firstUser.message.runId;
  const epoch = createPromptSurfaceEpoch({
    runId,
    epochId: "epoch-prefix-characterization",
    modelRef: MODEL.ref,
    stableHeadFingerprint: `sha256:${"a".repeat(64)}`,
    toolSchemaFingerprint: `sha256:${"b".repeat(64)}`,
    cacheSettingsFingerprint: `sha256:${"c".repeat(64)}`,
    resetReason: "INITIAL",
    createdStepSequence: 1,
    createdAt: 1 as never,
  });
  const snapshots = workCommentaries.map((commentary, index) =>
    (() => {
      const anchored = index === 0 ? conversationMessages[0]! : conversationMessages.at(-1)!;
      return createPromptSurfaceSnapshot({
        runId,
        epochId: epoch.epochId,
        ordinal: index + 1,
        anchor: {
          messageId: anchored.message.id,
          runId: anchored.message.runId,
          conversationTurnId: anchored.message.conversationTurnId,
          sequence: anchored.sequence,
        },
        sourceStepSequence: index + 1,
        kind: "RUNTIME_CONTEXT_SNAPSHOT",
        content: `<runtime_context_snapshot>\n${commentary}\n</runtime_context_snapshot>`,
        createdAt: (index + 1) as never,
      });
    })(),
  );

  return {
    conversationMessages,
    document,
    plan,
    receipt: {
      contextFingerprint: fingerprint,
      mode: "NORMAL",
      modelRef: MODEL.ref,
      policyFingerprint: "sha256:stable-policy",
      sources: [],
      budget: plan.budget,
      pressure: plan.pressure,
      toolSchemaTokens: 0,
      materializedTokens: 0,
    },
    promptSurface: {
      epoch: { ...epoch, snapshots },
      receipt: {
        epochId: epoch.epochId,
        prefixFingerprint: `sha256:${"d".repeat(64)}`,
        stableHeadTokens: 12,
        snapshotTokens: 9 * snapshots.length,
        expectedReusablePrefixTokens: 12 + 9 * snapshots.length,
        resetReason: "INITIAL",
      },
    },
    observationPolicy: {
      maxSingleObservationTokens: 100,
      maxObservationBatchTokens: 200,
    },
    contextFingerprint: fingerprint,
  };
}

describe("Prompt Surface prefix characterization", () => {
  it("keeps the stable head and prior request byte-identical as runtime snapshots append", async () => {
    const materializer = createContextMaterializer({
      projectors: createStandardAgentMessageProjectorRegistry(),
      tokenEstimator: createUtf8HeuristicTokenEstimator(),
    });
    const signal = new AbortController().signal;
    const firstMessages = await materializer.materialize({
      prepared: prepared(["work commentary: clean"]),
      model: MODEL,
      signal,
    });
    const secondMessages = await materializer.materialize({
      prepared: prepared(["work commentary: clean", "work commentary: dirty"]),
      model: MODEL,
      signal,
    });
    const firstRequest = {
      messages: firstMessages,
      tools: TOOL_CATALOG,
      settings: MODEL_SETTINGS,
    };
    const secondRequest = {
      messages: secondMessages,
      tools: TOOL_CATALOG,
      settings: MODEL_SETTINGS,
    };
    const firstSystemChanged =
      JSON.stringify(firstRequest.messages[0]) !== JSON.stringify(secondRequest.messages[0]);
    const secondExtendsFirst = firstRequest.messages.every(
      (message, index) => JSON.stringify(message) === JSON.stringify(secondRequest.messages[index]),
    );
    const sameTools = JSON.stringify(firstRequest.tools) === JSON.stringify(secondRequest.tools);
    const sameSettings =
      JSON.stringify(firstRequest.settings) === JSON.stringify(secondRequest.settings);
    const status = firstSystemChanged && !secondExtendsFirst ? "PREFIX_UNSTABLE" : "PREFIX_STABLE";

    expect(firstSystemChanged).toBe(false);
    expect(secondExtendsFirst).toBe(true);
    expect(sameTools).toBe(true);
    expect(sameSettings).toBe(true);
    expect(secondRequest.messages.at(-1)?.content).toContain("work commentary: dirty");
    expect(status).toBe("PREFIX_STABLE");
  });
});
