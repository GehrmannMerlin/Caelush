import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  createContextDocumentBuilder,
  createContextItem,
  createContextItemId,
  createContextMaterializer,
  createContextPlanner,
  createContextPolicy,
  createContextSourceId,
  createStandardAgentMessageProjectorRegistry,
  createUtf8HeuristicTokenEstimator,
  createContextFingerprint,
  type AgentMessageProjectorRegistry,
  type PreparedAgentContext,
} from "@caelush/agent";

import { assistantMessage, toolResultMessage, userMessage } from "../messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7d-materializer" },
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

function prepared(): PreparedAgentContext {
  const instruction = createContextItem({
    id: createContextItemId("reference:instruction"),
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
    whyLoaded: "test reference",
    payload: { kind: "TEXT", text: "Reference context, never a conversation instruction." },
  });
  const contribution = createContextItem({
    id: createContextItemId("contribution:fact"),
    type: "agent.extension-contribution",
    source: {
      providerId: createContextSourceId("agent.extension-contributions"),
      sourceRef: "hook/fact",
      version: "v1",
    },
    scope: "TURN",
    retention: "EPHEMERAL",
    priorityClass: "HIGH",
    tokenEstimate: 4,
    cacheStability: "DYNAMIC",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    whyLoaded: "validated contribution",
    payload: { kind: "TEXT", text: "[REDACTED:HOST_PATH]" },
  });
  const policy = createContextPolicy({
    model: MODEL,
    requestOverhead: { toolSchemaTokens: 0, protocolOverheadTokens: 0, totalTokens: 0 },
    options: { outputReserveTokens: 1, safetyReserveTokens: 1 },
  });
  const plan = createContextPlanner().plan({ items: [instruction, contribution], policy });
  const document = createContextDocumentBuilder().build({
    plan,
    rehydrated: {
      goal: "Materialize the current turn.",
      changedFiles: [],
      pendingApprovals: [],
      activeProcesses: [],
      verificationState: "not-run",
      resourceGovernance: "bounded",
      projectFacts: [],
    },
  });
  const historicalUser = userMessage({ sequence: 1, text: "historical question" });
  const historicalAssistant = assistantMessage({ sequence: 2, text: "historical answer" });
  const historicalCall = assistantMessage({ sequence: 3, toolCalls: ["closed_call"] });
  const historicalResult = toolResultMessage({ sequence: 4, toolCallId: "closed_call" });
  const currentUser = userMessage({ sequence: 5, text: "current question" });
  const currentOpenCall = assistantMessage({ sequence: 6, toolCalls: ["open_call"] });
  const hidden = userMessage({ sequence: 7, text: "hidden message", modelVisible: false });

  return {
    conversationMessages: [
      historicalUser,
      historicalAssistant,
      historicalCall,
      historicalResult,
      currentUser,
      currentOpenCall,
      hidden,
    ],
    document,
    plan,
    receipt: {
      contextFingerprint: createContextFingerprint("sha256:phase-7d-materializer"),
      mode: "NORMAL",
      modelRef: MODEL.ref,
      policyFingerprint: "sha256:phase-7d-policy",
      sources: [],
      budget: plan.budget,
      pressure: plan.pressure,
      toolSchemaTokens: 0,
      materializedTokens: 0,
    },
    observationPolicy: {
      maxSingleObservationTokens: 100,
      maxObservationBatchTokens: 200,
    },
    contextFingerprint: createContextFingerprint("sha256:phase-7d-materializer"),
  };
}

function recordingRegistry(seenVersions: number[]): AgentMessageProjectorRegistry {
  const standard = createStandardAgentMessageProjectorRegistry();
  return {
    has: standard.has,
    get: standard.get,
    project(stored) {
      seenVersions.push(stored.modelProjectionVersion ?? -1);
      return standard.project(stored);
    },
  };
}

describe("Phase 7D ContextMaterializer", () => {
  it("renders a system document, projects stored messages, hides non-model messages, and closes Tool order", async () => {
    const versions: number[] = [];
    const materializer = createContextMaterializer({
      projectors: recordingRegistry(versions),
      tokenEstimator: createUtf8HeuristicTokenEstimator(),
    });

    const messages = await materializer.materialize({
      prepared: prepared(),
      model: MODEL,
      signal: new AbortController().signal,
    });

    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.content).toContain("Reference context");
    expect(messages[0]?.content).toContain("<context_contributions>");
    expect(messages[0]?.content).toContain("[REDACTED:HOST_PATH]");
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "assistant",
      "tool",
      "user",
      "assistant",
    ]);
    expect(messages.map((message) => message.content).join(" ")).not.toContain("hidden message");
    expect(messages.at(-2)).toMatchObject({ role: "user", content: "current question" });
    expect(messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(versions).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("is deterministic and propagates abort before returning partial messages", async () => {
    const materializer = createContextMaterializer({
      projectors: createStandardAgentMessageProjectorRegistry(),
      tokenEstimator: createUtf8HeuristicTokenEstimator(),
    });
    const first = await materializer.materialize({
      prepared: prepared(),
      model: MODEL,
      signal: new AbortController().signal,
    });
    const second = await materializer.materialize({
      prepared: prepared(),
      model: MODEL,
      signal: new AbortController().signal,
    });
    expect(second).toEqual(first);

    const controller = new AbortController();
    controller.abort();
    await expect(
      materializer.materialize({ prepared: prepared(), model: MODEL, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reprojects only the recovery tail while preserving normal historical projection", async () => {
    let reprojectCalls = 0;
    const materializer = createContextMaterializer({
      projectors: createStandardAgentMessageProjectorRegistry(),
      tokenEstimator: createUtf8HeuristicTokenEstimator(),
      toolObservationReprojector: {
        async reproject({ stored }) {
          reprojectCalls += 1;
          if (stored.message.type !== "TOOL_RESULT") return undefined;
          return {
            role: "tool",
            toolCallId: stored.message.toolCallId,
            toolName: stored.message.toolName,
            content: "reprojected recovery content",
            isError: stored.message.isError,
          };
        },
      },
    });

    const normal = await materializer.materialize({
      prepared: prepared(),
      model: MODEL,
      signal: new AbortController().signal,
    });
    expect(normal.find((message) => message.role === "tool")).toMatchObject({
      content: "tool output",
    });
    expect(reprojectCalls).toBe(0);

    const recovered = await materializer.materialize({
      prepared: prepared(),
      model: MODEL,
      signal: new AbortController().signal,
      reprojectOpenToolObservations: true,
    });
    expect(recovered.find((message) => message.role === "tool")).toMatchObject({
      content: "reprojected recovery content",
    });
    expect(reprojectCalls).toBe(1);
  });
});
