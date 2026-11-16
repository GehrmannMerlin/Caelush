import { describe, expect, it } from "vitest";
import type { ModelDescriptor } from "@caelush/ai";
import {
  createContextPlanner,
  createContextPolicy,
  createCorePolicyContextSourceProvider,
  createWorkflowInstructionContextSourceProvider,
  type ActiveWorkflowResourceReader,
} from "@caelush/agent";
import { createRunId, WorkflowResourceBindingV1Schema } from "@caelush/protocol";

const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "workflow-budget" },
  api: "fixture-chat",
  limits: { contextWindowTokens: 4_000, maxOutputTokens: 512 },
  capabilities: {
    streaming: "UNKNOWN",
    toolCalling: "UNKNOWN",
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

const runId = createRunId();
const body = "Core workflow rule. ".repeat(30);

function resource(bindingId: string, activationOrdinal: number) {
  const utf8Bytes = Buffer.byteLength(body, "utf8");
  return {
    binding: WorkflowResourceBindingV1Schema.parse({
      runId,
      resourceKind: "WORKFLOW_INSTRUCTION",
      resourceId: `skill:${bindingId}`,
      resourceRevision: "sha256:bundle",
      artifactRef: `skill:${bindingId}`,
      sourceFingerprint: "sha256:manifest",
      utf8Bytes,
      tokenEstimate: Math.ceil(utf8Bytes / 3),
      bindingId,
      activationOrdinal,
    }),
    rendererVersion: "workflow-resource@1",
    body,
  };
}

function input(effectiveInputLimitTokens: number) {
  return {
    identity: { runId, sessionId: "session:workflow-budget" as never, goal: "Check budget" },
    turn: { stepId: "step:workflow-budget" as never, sequence: 1 },
    conversation: {} as never,
    input: { kind: "CONTINUATION" as const, reason: "STEERING" as const },
    model: MODEL,
    mode: "NORMAL" as const,
    policy: { effectiveInputLimitTokens } as never,
    signal: new AbortController().signal,
  };
}

describe("Phase 04 required workflow Context budgets", () => {
  it("fails the whole projection when selected cores exceed the independent core budget", async () => {
    const reader: ActiveWorkflowResourceReader = {
      async load() {
        return [resource("binding-one", 1), resource("binding-two", 2)];
      },
    };
    const provider = createWorkflowInstructionContextSourceProvider({
      reader,
      estimateTokens: () => 20,
    });

    await expect(provider.collect(input(300))).rejects.toThrow(/independent token budget/u);
  });

  it("fails closed when required active core plus other must-use Context exceeds the total budget", async () => {
    const reader: ActiveWorkflowResourceReader = {
      async load() {
        return [resource("binding-required", 1)];
      },
    };
    const provider = createWorkflowInstructionContextSourceProvider({
      reader,
      estimateTokens: () => 20,
    });
    const sourceInput = input(400);
    const result = await provider.collect(sourceInput);
    const corePolicy = await createCorePolicyContextSourceProvider({
      text: "Required system guidance. ".repeat(200),
    }).collect(sourceInput);
    const totalBudget = {
      ...createContextPolicy({ model: MODEL, tools: [] }),
      effectiveInputLimitTokens: 400,
    };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      retention: "PINNED",
      priorityClass: "CRITICAL",
      type: "agent.workflow-instruction",
    });
    expect(() =>
      createContextPlanner().plan({
        items: [...corePolicy.items, ...result.items],
        policy: totalBudget,
      }),
    ).toThrow(/mandatory context|budget/iu);
  });
});
