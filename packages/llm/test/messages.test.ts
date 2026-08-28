import { describe, expect, it } from "vitest";
import {
  LLMAssistantMessageSchema,
  LLMMessageSchema,
  LLMSystemMessageSchema,
  LLMToolResultMessageSchema,
  LLMUserMessageSchema,
} from "../src/index.js";

const fixtures = [
  { role: "system", content: "" },
  { role: "user", content: "Inspect the repository." },
  {
    role: "assistant",
    content: [
      { type: "text", text: "I need one file." },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        input: { path: "README.md" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "read_file",
        input: { path: "AGENTS.md" },
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call-1",
    toolName: "read_file",
    content: "file contents",
    isError: false,
  },
] as const;

describe("LLM messages", () => {
  it("accepts V1 message forms and tool-only assistant content", () => {
    for (const fixture of fixtures) {
      expect(LLMMessageSchema.parse(fixture)).toEqual(fixture);
    }
  });

  it("round-trips every message fixture through JSON", () => {
    for (const fixture of fixtures) {
      const parsed = LLMMessageSchema.parse(JSON.parse(JSON.stringify(fixture)));
      expect(parsed).toEqual(fixture);
    }
  });

  it("keeps each role schema strict and rejects unsupported content", () => {
    expect(
      LLMSystemMessageSchema.safeParse({ role: "system", content: "ok", typo: true }).success,
    ).toBe(false);
    expect(
      LLMUserMessageSchema.safeParse({ role: "user", content: "ok", image: "..." }).success,
    ).toBe(false);
    expect(LLMAssistantMessageSchema.safeParse({ role: "assistant", content: [] }).success).toBe(
      false,
    );
    expect(
      LLMToolResultMessageSchema.safeParse({
        role: "tool",
        toolCallId: "x",
        toolName: "x",
        content: "",
        isError: false,
        details: {},
      }).success,
    ).toBe(false);
  });
});
