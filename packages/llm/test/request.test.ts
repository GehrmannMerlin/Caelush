import { describe, expect, it } from "vitest";
import { createLLMCallId } from "@caelush/protocol";
import {
  FinishReasonSchema,
  LLMRequestSchema,
  LLMToolCallSchema,
  LLMToolChoiceSchema,
  LLMTurnResultSchema,
} from "../src/index.js";

const model = { provider: "local", model: "test-model" };
const messages = [{ role: "user", content: "List the files." }] as const;
const tool = {
  name: "list_files",
  description: "List files in a directory",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { kind: "local" },
} as const;

describe("LLM requests", () => {
  it("accepts one provider-turn request and every tool choice", () => {
    const choices = [
      { type: "AUTO" },
      { type: "NONE" },
      { type: "REQUIRED" },
      { type: "TOOL", toolName: "list_files" },
    ] as const;

    for (const toolChoice of choices) {
      expect(
        LLMRequestSchema.parse({
          model,
          messages,
          tools: [tool],
          toolChoice,
          maxOutputTokens: 128,
          temperature: 0.7,
        }),
      ).toMatchObject({ model, messages, toolChoice });
      expect(LLMToolChoiceSchema.parse(toolChoice)).toEqual(toolChoice);
    }
  });

  it("rejects provider-specific fields and invalid generation bounds", () => {
    const base = { model, messages };
    expect(LLMRequestSchema.safeParse({ ...base, providerOptions: {} }).success).toBe(false);
    expect(LLMRequestSchema.safeParse({ ...base, temperature: Number.NaN }).success).toBe(false);
    expect(LLMRequestSchema.safeParse({ ...base, temperature: 2.1 }).success).toBe(false);
    expect(LLMRequestSchema.safeParse({ ...base, maxOutputTokens: 0 }).success).toBe(false);
    expect(LLMRequestSchema.safeParse({ ...base, maxOutputTokens: 1.5 }).success).toBe(false);
    expect(
      LLMRequestSchema.safeParse({
        ...base,
        tools: [{ ...tool, execute: () => "must not be here" }],
      }).success,
    ).toBe(false);
  });

  it("normalizes completed tool calls without retaining raw input", () => {
    const call = { id: "call-1", name: "list_files", input: { path: "." } };
    expect(LLMToolCallSchema.parse(call)).toEqual(call);
    expect(LLMToolCallSchema.safeParse({ ...call, rawInput: '{"path":"."}' }).success).toBe(false);
    expect(FinishReasonSchema.parse("TOOL_CALLS")).toBe("TOOL_CALLS");
    expect(
      LLMTurnResultSchema.parse({
        callId: createLLMCallId(),
        providerId: "local",
        model,
        text: "",
        toolCalls: [call],
        finishReason: "TOOL_CALLS",
      }),
    ).toMatchObject({ text: "", toolCalls: [call] });
  });
});
