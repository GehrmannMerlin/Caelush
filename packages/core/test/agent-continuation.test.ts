import {
  createLLMCallId,
  createRunId,
  createStepId,
  ModelRefSchema,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentFinalCandidateDecisionSchema,
  AgentToolCallsDecisionSchema,
  RunContinuationCheckpointSchema,
} from "../src/agent-continuation-schema.js";

const runId = createRunId();
const sourceStepId = createStepId();
const model = ModelRefSchema.parse({ provider: "fixture", model: "fixture-model" });

const assistantWithToolCall = {
  role: "assistant" as const,
  content: [
    {
      type: "tool-call" as const,
      toolCallId: "call_a",
      toolName: "read_file" as const,
      input: { path: "src/index.ts" },
    },
  ],
};

const toolDecision = {
  type: "TOOL_CALLS_REQUESTED" as const,
  modelTurn: {
    callId: createLLMCallId(),
    model,
    finishReason: "TOOL_CALLS" as const,
    assistantMessage: assistantWithToolCall,
    usage: { inputTokens: 10, outputTokens: 4 },
  },
  toolRequests: [
    {
      externalCallId: "call_a",
      toolName: "read_file" as const,
      args: { path: "src/index.ts" },
    },
  ],
};

describe("durable continuation schemas", () => {
  it("validates a waiting-tool-results checkpoint and its accepted result batch", () => {
    const checkpoint = {
      type: "WAITING_TOOL_RESULTS" as const,
      runId,
      sourceStepId,
      pendingDecision: toolDecision,
      receivedResults: [
        {
          role: "tool" as const,
          toolCallId: "call_a",
          toolName: "read_file" as const,
          content: "source",
          isError: false,
        },
      ],
    };

    expect(RunContinuationCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(AgentToolCallsDecisionSchema.parse(toolDecision)).toEqual(toolDecision);
  });

  it("validates a final candidate checkpoint without treating it as a completed run", () => {
    const decision = {
      type: "FINAL_CANDIDATE" as const,
      modelTurn: {
        callId: createLLMCallId(),
        model,
        finishReason: "STOP" as const,
        assistantMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "answer" }] },
      },
      candidateText: "answer",
    };
    const checkpoint = { type: "AWAITING_VERIFICATION" as const, runId, sourceStepId, finalDecision: decision };

    expect(RunContinuationCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(AgentFinalCandidateDecisionSchema.parse(decision)).toEqual(decision);
  });

  it("rejects malformed or synthetic continuation data", () => {
    expect(() => RunContinuationCheckpointSchema.parse({ type: "WAITING_TOOL_RESULTS", runId, sourceStepId })).toThrow();
    expect(() => RunContinuationCheckpointSchema.parse({ type: "AWAITING_VERIFICATION", runId, sourceStepId, finalDecision: { candidateText: "answer" } })).toThrow();
    expect(() => RunContinuationCheckpointSchema.parse({ type: "WAITING_TOOL_RESULTS", runId, sourceStepId, pendingDecision: toolDecision, systemPrompt: "secret" })).toThrow();
  });
});
