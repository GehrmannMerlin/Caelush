import { describe, expect, it } from "vitest";
import { AIError } from "../src/errors/ai-error.js";
import { validateAIModelRequest } from "../src/request/request-validator.js";
import { modelDescriptor } from "./support/fixtures.js";
import type { AIModelRequest } from "../src/request/model-request.js";
import type { ModelDescriptor } from "../src/models/model-descriptor.js";

const MODEL = modelDescriptor();

/**
 * Build a request literal.
 *
 * The override bag is deliberately loosely typed: most of this file asserts that
 * malformed requests are rejected, so the values under test cannot satisfy
 * `AIModelRequest`.
 */
function request(overrides: Record<string, unknown> = {}): AIModelRequest {
  return {
    model: { provider: "test", model: "model-a" },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as AIModelRequest;
}

/** Assert the validator rejects a request as AI_INVALID_REQUEST. */
function expectInvalid(value: unknown, model: ModelDescriptor = MODEL): void {
  try {
    validateAIModelRequest(value, model);
    expect.unreachable(`expected AI_INVALID_REQUEST for ${JSON.stringify(value) ?? "undefined"}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).code).toBe("AI_INVALID_REQUEST");
    expect((error as AIError).retryable).toBe(false);
  }
}

/** Assert the validator rejects a request as AI_CAPABILITY_UNSUPPORTED. */
function expectCapabilityUnsupported(value: unknown, model: ModelDescriptor): void {
  try {
    validateAIModelRequest(value, model);
    expect.unreachable("expected AI_CAPABILITY_UNSUPPORTED");
  } catch (error) {
    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).code).toBe("AI_CAPABILITY_UNSUPPORTED");
  }
}

const READ_FILE = {
  name: "read_file",
  description: "read a file",
  inputSchema: { type: "object" },
};

describe("request shape validation", () => {
  it("accepts a minimal and a full request", () => {
    expect(() => {
      validateAIModelRequest(request(), MODEL);
    }).not.toThrow();

    expect(() => {
      validateAIModelRequest(
        request({
          tools: [READ_FILE],
          toolChoice: { type: "TOOL", toolName: "read_file" },
          settings: {
            maxOutputTokens: 500,
            temperature: 0.7,
            reasoning: { level: "MEDIUM" },
            cache: { retention: "SHORT", key: "conv-1" },
          },
        }),
        modelDescriptor({
          reasoning: { supportedLevels: ["LOW", "MEDIUM"], supportsSummary: "SUPPORTED" },
          cache: { supportedRetentions: ["SHORT"] },
        }),
      );
    }).not.toThrow();
  });

  it("rejects a missing model, messages or unknown field", () => {
    expectInvalid({ messages: [{ role: "user", content: "hi" }] });
    expectInvalid({ model: { provider: "test", model: "model-a" } });
    expectInvalid({ model: { provider: "test", model: "model-a" }, messages: [] });
    expectInvalid(request({ model: { provider: "Test", model: "model-a" } }));
    expectInvalid(request({ extra: true }));
    expectInvalid(undefined);
    expectInvalid("request");
  });

  it("rejects invalid messages", () => {
    expectInvalid(request({ messages: [{ role: "assistant", content: [] }] }));
    expectInvalid(request({ messages: [{ role: "user" }] }));
    expectInvalid(
      request({ messages: [{ role: "tool", toolCallId: "c", toolName: "t", content: "x" }] }),
    );
  });

  it("rejects unknown settings fields, including provider spellings", () => {
    for (const settings of [
      { reasoning_effort: "high" },
      { budget_tokens: 1_000 },
      { thinkingConfig: { type: "enabled" } },
      { cache_control: { type: "ephemeral" } },
      { cachePoint: true },
      { providerOptions: {} },
      { max_output_tokens: 10 },
    ]) {
      expectInvalid(request({ settings }));
    }
  });
});

describe("request tool validation", () => {
  it("rejects duplicate tool names", () => {
    expectInvalid(request({ tools: [READ_FILE, READ_FILE] }));
    expectInvalid(
      request({
        tools: [READ_FILE, { ...READ_FILE, description: "other" }],
      }),
    );
  });

  it("rejects malformed tools and tool choices", () => {
    expectInvalid(request({ tools: [] }));
    expectInvalid(request({ tools: [{ name: "", description: "d", inputSchema: {} }] }));
    expectInvalid(request({ tools: [{ name: "t", description: "d" }] }));
    expectInvalid(request({ toolChoice: { type: "MAYBE" } }));
    expectInvalid(request({ toolChoice: { type: "TOOL" } }));
    expectInvalid(request({ tools: [READ_FILE], toolChoice: { type: "TOOL", toolName: "" } }));
  });

  it("requires an existing tool for a TOOL choice", () => {
    expectInvalid(request({ toolChoice: { type: "TOOL", toolName: "read_file" } }));
    expectInvalid(
      request({ tools: [READ_FILE], toolChoice: { type: "TOOL", toolName: "write_file" } }),
    );

    expect(() => {
      validateAIModelRequest(
        request({ tools: [READ_FILE], toolChoice: { type: "TOOL", toolName: "read_file" } }),
        MODEL,
      );
    }).not.toThrow();
  });

  it("requires tools for REQUIRED and TOOL choices", () => {
    expectInvalid(request({ toolChoice: { type: "REQUIRED" } }));
    expectInvalid(request({ toolChoice: { type: "REQUIRED" }, tools: [] }));
    expectInvalid(request({ toolChoice: { type: "TOOL", toolName: "read_file" }, tools: [] }));

    expect(() => {
      validateAIModelRequest(
        request({ tools: [READ_FILE], toolChoice: { type: "REQUIRED" } }),
        MODEL,
      );
    }).not.toThrow();
  });

  it("allows AUTO and NONE without tools", () => {
    for (const toolChoice of [{ type: "AUTO" }, { type: "NONE" }]) {
      expect(() => {
        validateAIModelRequest(request({ toolChoice }), MODEL);
      }).not.toThrow();
    }
  });
});

describe("request numeric validation", () => {
  it("rejects maxOutputTokens that is not a positive integer within the model limit", () => {
    for (const maxOutputTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8_001, "10"]) {
      expectInvalid(request({ settings: { maxOutputTokens } }));
    }

    for (const maxOutputTokens of [1, 8_000]) {
      expect(() => {
        validateAIModelRequest(request({ settings: { maxOutputTokens } }), MODEL);
      }).not.toThrow();
    }
  });

  it("rejects a temperature outside [0, 2] or not finite", () => {
    for (const temperature of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 2.1, "0.5"]) {
      expectInvalid(request({ settings: { temperature } }));
    }

    for (const temperature of [0, 1, 2]) {
      expect(() => {
        validateAIModelRequest(request({ settings: { temperature } }), MODEL);
      }).not.toThrow();
    }
  });
});

describe("request capability validation", () => {
  it("rejects tools when tool calling is explicitly UNSUPPORTED", () => {
    const unsupported = modelDescriptor({
      capabilities: { ...modelDescriptor().capabilities, toolCalling: "UNSUPPORTED" },
    });

    expectCapabilityUnsupported(request({ tools: [READ_FILE] }), unsupported);
  });

  it("rejects an explicit reasoning request when reasoning is explicitly UNSUPPORTED", () => {
    const unsupported = modelDescriptor({
      capabilities: { ...modelDescriptor().capabilities, reasoning: "UNSUPPORTED" },
    });

    expectCapabilityUnsupported(
      request({ settings: { reasoning: { level: "LOW" } } }),
      unsupported,
    );
  });

  it("allows UNKNOWN capabilities to be attempted", () => {
    const unknown = modelDescriptor({
      capabilities: {
        ...modelDescriptor().capabilities,
        toolCalling: "UNKNOWN",
        reasoning: "UNKNOWN",
      },
      reasoning: { supportedLevels: ["LOW"], supportsSummary: "UNKNOWN" },
    });

    expect(() => {
      validateAIModelRequest(
        request({ tools: [READ_FILE], settings: { reasoning: { level: "LOW" } } }),
        unknown,
      );
    }).not.toThrow();
  });

  it("never rejects an unsupported cache request: that is a downgrade", () => {
    const noCache = modelDescriptor({ cache: { supportedRetentions: [] } });

    expect(() => {
      validateAIModelRequest(
        request({ settings: { cache: { retention: "LONG", key: "conv-1" } } }),
        noCache,
      );
    }).not.toThrow();
  });
});
