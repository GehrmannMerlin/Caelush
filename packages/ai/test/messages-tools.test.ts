import { describe, expect, it } from "vitest";
import { isJsonObject, isJsonValue } from "../src/json/json-value.js";
import {
  assertAIAssistantContent,
  assertAIMessage,
  assertAIMessages,
  isAIAssistantContent,
} from "../src/messages/index.js";
import { assertModelUsage, normalizeModelUsage } from "../src/models/model-usage.js";
import { assertAIToolChoice } from "../src/request/tool-choice.js";
import { assertAIToolCall, assertAIToolSpec } from "../src/tools/index.js";
import type { AIMessage } from "../src/messages/index.js";
import type { AIAssistantContent } from "../src/messages/index.js";
import type { ModelUsage } from "../src/models/model-usage.js";

describe("AI JSON guards", () => {
  it("accepts JSON-safe values only", () => {
    expect(isJsonValue({ a: [1, "b", null, true] })).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject({})).toBe(true);

    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(() => undefined)).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue([undefined])).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });
});

describe("AI messages", () => {
  it("accepts the frozen text/tool-first message shapes", () => {
    const messages: AIMessage[] = [
      { role: "system", content: "you are caelush" },
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } },
        ],
      },
      { role: "tool", toolCallId: "c1", toolName: "read_file", content: "data", isError: false },
      { role: "tool", toolCallId: "c1", toolName: "read_file", content: "boom", isError: true },
    ];

    expect(() => {
      assertAIMessages(messages);
    }).not.toThrow();
  });

  it("requires non-empty assistant content", () => {
    expect(() => {
      assertAIMessage({ role: "assistant", content: [{ type: "text", text: "" }] });
    }).not.toThrow();
    expect(() => {
      assertAIMessage({ role: "assistant", content: [] });
    }).toThrow(TypeError);
  });

  it("rejects structurally invalid messages", () => {
    const invalid: unknown[] = [
      undefined,
      null,
      "user",
      {},
      { role: "user" },
      { role: "user", content: 1 },
      { role: "developer", content: "x" },
      { role: "assistant", content: [{ type: "image", text: "x" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "", toolName: "t", input: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c", toolName: "", input: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c", toolName: "t", input: [] }],
      },
      { role: "tool", toolCallId: "", toolName: "t", content: "x", isError: false },
      { role: "tool", toolCallId: "c", toolName: "", content: "x", isError: false },
      { role: "tool", toolCallId: "c", toolName: "t", content: "x" },
      { role: "tool", toolCallId: "c", toolName: "t", content: "x", isError: "no" },
      { role: "tool", toolCallId: "c", toolName: "t", content: 5, isError: false },
    ];

    for (const message of invalid) {
      expect(
        () => {
          assertAIMessage(message);
        },
        JSON.stringify(message) ?? "undefined",
      ).toThrow(TypeError);
    }
  });

  it("rejects an empty message list", () => {
    expect(() => {
      assertAIMessages([]);
    }).toThrow(TypeError);
  });

  it("guards assistant content members", () => {
    expect(isAIAssistantContent({ type: "text", text: "a" })).toBe(true);
    expect(isAIAssistantContent({ type: "text", text: 1 })).toBe(false);

    for (const content of [{ type: "text", text: 1 }, { type: "nope" }, null] as unknown[]) {
      expect(() => {
        assertAIAssistantContent(content);
      }).toThrow(TypeError);
    }

    expect(() => {
      assertAIAssistantContent({ type: "text", text: "ok" });
    }).not.toThrow();

    // A content *list* is not a content member.
    expect(() => {
      assertAIAssistantContent([{ type: "text", text: "ok" } satisfies AIAssistantContent]);
    }).toThrow(TypeError);
  });
});

describe("AI tool specs and calls", () => {
  it("accepts a data-only tool specification", () => {
    expect(() => {
      assertAIToolSpec({
        name: "read_file",
        description: "read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      });
    }).not.toThrow();
  });

  it("rejects a tool specification that is not data-only JSON", () => {
    for (const spec of [
      { name: "", description: "d", inputSchema: {} },
      { name: "t", description: "d", inputSchema: [] },
      { name: "t", description: "d", inputSchema: { bad: undefined } },
      { name: "t", description: 1, inputSchema: {} },
      { name: "t", inputSchema: {} },
    ] as unknown[]) {
      expect(() => {
        assertAIToolSpec(spec);
      }).toThrow(TypeError);
    }
  });

  it("rejects a tool call without identity or JSON input", () => {
    expect(() => {
      assertAIToolCall({ id: "c1", name: "read_file", input: { path: "a.ts" } });
    }).not.toThrow();

    for (const call of [
      { id: "", name: "t", input: {} },
      { id: "c", name: "", input: {} },
      { id: "c", name: "t", input: [] },
      { id: "c", name: "t" },
    ] as unknown[]) {
      expect(() => {
        assertAIToolCall(call);
      }).toThrow(TypeError);
    }
  });
});

describe("AI tool choice", () => {
  it("accepts the frozen four-variant choice", () => {
    for (const choice of [
      { type: "AUTO" },
      { type: "NONE" },
      { type: "REQUIRED" },
      { type: "TOOL", toolName: "read_file" },
    ] as unknown[]) {
      expect(() => {
        assertAIToolChoice(choice);
      }, JSON.stringify(choice)).not.toThrow();
    }
  });

  it("rejects unknown or incomplete choices", () => {
    for (const choice of [
      { type: "AUTO", toolName: "t" },
      { type: "TOOL" },
      { type: "TOOL", toolName: "" },
      { type: "auto" },
      { toolName: "t" },
      null,
    ] as unknown[]) {
      expect(() => {
        assertAIToolChoice(choice);
      }).toThrow(TypeError);
    }
  });
});

describe("model usage", () => {
  it("keeps a usage snapshot optional and non-negative", () => {
    expect(() => {
      assertModelUsage(undefined);
    }).not.toThrow();
    expect(() => {
      assertModelUsage({});
    }).not.toThrow();
    expect(() => {
      assertModelUsage({
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cachedInputTokens: 4,
        reasoningTokens: 1,
      });
    }).not.toThrow();

    for (const usage of [
      { inputTokens: -1 },
      { inputTokens: 1.5 },
      { outputTokens: Number.NaN },
      { totalTokens: Number.POSITIVE_INFINITY },
      { cachedInputTokens: "4" },
      { reasoningTokens: null },
    ] as unknown[]) {
      expect(() => {
        assertModelUsage(usage);
      }).toThrow(TypeError);
    }
  });

  it("drops unknown fields when normalizing a usage snapshot", () => {
    const withExtra = { inputTokens: 3, extra: "x" } as unknown as ModelUsage;

    expect(normalizeModelUsage(withExtra)).toEqual({ inputTokens: 3 });
    expect(normalizeModelUsage(undefined)).toBeUndefined();
    expect(normalizeModelUsage({})).toEqual({});
  });
});
