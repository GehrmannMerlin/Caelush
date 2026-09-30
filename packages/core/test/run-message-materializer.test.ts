import type { AgentModelTurn } from "@caelush/agent";
import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import { createAssistantMessageAppend } from "../src/run-message-materializer.js";
import { testRunMessageAuthority } from "./support/run-message-authority.js";

const NOW = createTimestampMs(1_000);
const RUN = AgentRunSchema.parse({
  id: createRunId(),
  sessionId: createSessionId(),
  goal: "inspect the project",
  status: "RUNNING",
  workspace: { id: createWorkspaceId(), path: "/repo" },
  model: { provider: "fixture", model: "fixture-model" },
  runtime: { id: "local", kind: "fixture" },
  permissionProfile: "READ_ONLY",
  approvalPolicy: "ALWAYS_ASK",
  limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
  createdAt: NOW,
  startedAt: NOW,
});

const MODEL_TURN: AgentModelTurn = {
  callId: "llm_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
  model: { provider: "fixture", model: "fixture-model" },
  finishReason: "STOP",
  assistantMessage: { role: "assistant", content: [{ type: "text", text: "done" }] },
};

describe("assistant message materialization phases", () => {
  it("persists commentary for a turn that will continue into Tools", () => {
    const append = createAssistantMessageAppend(
      testRunMessageAuthority(),
      RUN,
      createStepId(),
      MODEL_TURN,
      "COMMENTARY",
    );

    expect(append.draft.data).toMatchObject({ phase: "COMMENTARY" });
  });

  it("persists final-answer intent without claiming completion", () => {
    const append = createAssistantMessageAppend(
      testRunMessageAuthority(),
      RUN,
      createStepId(),
      MODEL_TURN,
      "FINAL_ANSWER",
    );

    expect(append.draft.data).toMatchObject({ phase: "FINAL_ANSWER" });
    expect(RUN.status).toBe("RUNNING");
  });
});
