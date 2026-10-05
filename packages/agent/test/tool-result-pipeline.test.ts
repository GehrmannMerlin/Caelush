import type { JsonObject } from "@caelush/ai";
import {
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  type ToolInvocation,
  type ToolName,
} from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  boundToolResultContent,
  createToolCallPreparer,
  createToolResultPipeline,
  DEFAULT_TOOL_RESULT_LIMITS,
  DefaultAgentToolRegistryBuilder,
  isAgentToolResult,
  readResultShape,
  TOOL_RESULT_TRUNCATION_MARKER,
  ToolResultLimitError,
  validateToolResult,
  validateToolResultLimits,
  type AgentTool,
  type AgentToolRegistry,
  type PreparedToolCall,
  type ToolResultSanitizerPort,
  type ToolSettlementExtension,
  type ToolSettlementExtensionProjector,
} from "@caelush/agent";

/**
 * The canonical Tool result pipeline.
 *
 * ```text
 * raw AgentToolResult
 *   ↓ exact shape, details budget, resultDetailsSchema, copy/freeze
 *   ↓ sanitize
 *   ↓ exact shape, details budget, resultDetailsSchema AGAIN
 *   ↓ bound content to maxDurableContentBytes
 *   ↓ optional opaque settlement extension
 * PreparedToolSettlement
 * ```
 *
 * The two halves of the test file are the two things that make the pipeline trustworthy: it refuses
 * anything that does not satisfy the Tool's own contract, and it never lets an unproven value become
 * the thing a settlement commits.
 */

const detailsSchema: JsonObject = {
  type: "object",
  properties: { echoed: { type: "string" } },
  required: ["echoed"],
  additionalProperties: false,
};

function agentTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: "echo",
    description: "Echo text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    label: "Echo",
    resultDetailsSchema: detailsSchema,
    executionMode: "SEQUENTIAL",
    execute: async () => ({ content: "ok", details: { echoed: "ok" }, isError: false }),
    ...overrides,
  };
}

function fixture(tool: AgentTool = agentTool()): {
  readonly call: PreparedToolCall;
  readonly invocation: ToolInvocation;
  readonly registry: AgentToolRegistry;
} {
  const builder = new DefaultAgentToolRegistryBuilder();
  builder.register(tool);
  const registry = builder.build();
  const outcome = createToolCallPreparer(registry).prepare({
    externalCallId: "call-1",
    toolName: "echo",
    args: { text: "hello" },
  });
  if (outcome.kind !== "READY") throw new Error("the fixture Tool did not prepare");
  return {
    call: outcome.call,
    registry,
    invocation: {
      id: createToolInvocationId(),
      runId: createRunId(),
      stepId: createStepId(),
      toolName: "echo" as ToolName,
      externalCallId: "call-1",
      args: { text: "hello" },
      riskLevel: "LOW",
      status: "RUNNING",
      createdAt: createTimestampMs(1),
    },
  };
}

const NOW = createTimestampMs(2);

function acceptedSettlement(outcome: unknown): {
  readonly result: {
    readonly content: string;
    readonly details: JsonObject;
    readonly isError: boolean;
  };
  readonly effects?: ToolSettlementExtension | undefined;
} {
  const value = outcome as {
    readonly kind?: string;
    readonly settlement?: {
      readonly result: {
        readonly content: string;
        readonly details: JsonObject;
        readonly isError: boolean;
      };
      readonly effects?: ToolSettlementExtension | undefined;
    };
  };
  expect(value.kind).toBe("ACCEPTED");
  if (value.settlement === undefined) throw new Error("expected an accepted settlement");
  return value.settlement;
}

function expectOutputFailure(outcome: unknown): {
  readonly failure: {
    readonly error: { readonly code: string; readonly message: string };
    readonly feedback: {
      readonly disposition: string;
      readonly details: JsonObject;
      readonly blockToolFailures?: boolean;
    };
  };
} {
  const value = outcome as {
    readonly kind?: string;
    readonly failure?: {
      readonly error: { readonly code: string; readonly message: string };
      readonly feedback: {
        readonly disposition: string;
        readonly details: JsonObject;
        readonly blockToolFailures?: boolean;
      };
    };
  };
  expect(value.kind).toBe("FAILED");
  expect(value.failure?.error.code).toBe("TOOL_OUTPUT_ERROR");
  expect(value.failure?.feedback.disposition).toBe("SAFE_FAILURE");
  expect(value.failure?.feedback.blockToolFailures).toBeUndefined();
  return value as ReturnType<typeof expectOutputFailure>;
}

describe("ToolResultPipeline result contract", () => {
  it("accepts an exact result and freezes it", () => {
    const { call, invocation } = fixture();
    const outcome = createToolResultPipeline().process({
      call,
      invocation,
      rawResult: { content: "safe", details: { echoed: "safe" }, isError: false },
      now: NOW,
    });

    const settlement = acceptedSettlement(outcome);
    expect(settlement.result).toEqual({
      content: "safe",
      details: { echoed: "safe" },
      isError: false,
    });
    expect(Object.isFrozen(settlement.result)).toBe(true);
    expect(Object.isFrozen(settlement.result.details)).toBe(true);
    expect(settlement.effects).toBeUndefined();
  });

  it.each([
    ["an extra key", { content: "safe", details: { echoed: "safe" }, isError: false, extra: 1 }],
    ["a missing key", { content: "safe", isError: false }],
    ["a non-string content", { content: 1, details: { echoed: "safe" }, isError: false }],
    ["a non-boolean isError", { content: "safe", details: { echoed: "safe" }, isError: "no" }],
    ["an array details", { content: "safe", details: [], isError: false }],
    ["a null details", { content: "safe", details: null, isError: false }],
    ["a non-object result", null],
    ["a promise-like result", Promise.resolve({ content: "safe", details: {}, isError: false })],
  ])("rejects %s as a SHAPE violation", (_label, rawResult) => {
    const { call, invocation } = fixture();

    const outcome = createToolResultPipeline().process({
      call,
      invocation,
      rawResult: rawResult as never,
      now: NOW,
    });
    expectOutputFailure(outcome);
  });

  it("rejects a class instance that carries the right fields", () => {
    class Sneaky {
      readonly content = "safe";
      readonly details = { echoed: "safe" };
      readonly isError = false;
    }
    const { call, invocation } = fixture();

    expectOutputFailure(
      createToolResultPipeline().process({
        call,
        invocation,
        rawResult: new Sneaky() as never,
        now: NOW,
      }),
    );
  });

  it("rejects details that violate the registered result schema", () => {
    const { call, invocation } = fixture();

    expectOutputFailure(
      createToolResultPipeline().process({
        call,
        invocation,
        rawResult: { content: "safe", details: { echoed: 42 }, isError: false },
        now: NOW,
      }),
    );
  });

  it("rejects oversized details without truncating them", () => {
    const { call, invocation } = fixture();

    expectOutputFailure(
      createToolResultPipeline({
        limits: { maxDurableContentBytes: 1024, maxDetailsBytes: 8 },
      }).process({
        call,
        invocation,
        rawResult: { content: "safe", details: { echoed: "a".repeat(64) }, isError: false },
        now: NOW,
      }),
    );
  });

  it("bounds content at a whole-character UTF-8 boundary and marks it", () => {
    const { call, invocation } = fixture();
    const content = "ab中文🙂cd".repeat(10);

    const outcome = createToolResultPipeline({
      limits: { maxDurableContentBytes: 30, maxDetailsBytes: 4096 },
    }).process({
      call,
      invocation,
      rawResult: { content, details: { echoed: "safe" }, isError: false },
      now: NOW,
    });

    const settlement = acceptedSettlement(outcome);
    expect(settlement.result.content).toContain(TOOL_RESULT_TRUNCATION_MARKER);
    expect(Buffer.byteLength(settlement.result.content, "utf8")).toBeLessThanOrEqual(30);
    // No lone surrogate: the bounded text is valid UTF-8 end to end.
    expect(() => encodeURIComponent(settlement.result.content)).not.toThrow();
  });
});

describe("ToolResultSanitizerPort", () => {
  it("receives the tool name, the invocation and the validated result", () => {
    const { call, invocation } = fixture();
    const sanitize = vi.fn(({ result }: { result: { content: string } }) => ({
      kind: "SANITIZED",
      result: {
        content: `[safe] ${result.content}`,
        details: { echoed: "safe" },
        isError: false,
      },
    }));

    const outcome = createToolResultPipeline({ sanitizer: { sanitize } as never }).process({
      call,
      invocation,
      rawResult: { content: "unsafe", details: { echoed: "safe" }, isError: false },
      now: NOW,
    });

    expect(sanitize).toHaveBeenCalledTimes(1);
    const received = sanitize.mock.calls[0]![0] as unknown as {
      toolName: string;
      invocation: ToolInvocation;
      result: { content: string; details: JsonObject };
    };
    expect(received.toolName).toBe("echo");
    expect(received.invocation.id).toBe(invocation.id);
    expect(received.result.content).toBe("unsafe");
    expect(received.result.details).toEqual({ echoed: "safe" });
    expect(acceptedSettlement(outcome).result.content).toBe("[safe] unsafe");
  });

  it("materializes a sanitizer-produced schema error as a safe Tool failure", () => {
    const { call, invocation } = fixture();
    const sanitizer = {
      sanitize: () => ({
        kind: "SANITIZED",
        result: { content: "RAW_INVALID", details: { echoed: 42 }, isError: false },
      }),
    };

    const outcome = createToolResultPipeline({ sanitizer: sanitizer as never }).process({
      call,
      invocation,
      rawResult: { content: "safe", details: { echoed: "safe" }, isError: false },
      now: NOW,
    });
    expectOutputFailure(outcome);
    expect(JSON.stringify(outcome)).not.toContain("RAW_INVALID");
  });

  it("materializes a SANITIZED outcome with a missing field as a safe Tool failure", () => {
    const { call, invocation } = fixture();
    const sanitizer = {
      sanitize: () => ({
        kind: "SANITIZED",
        result: { content: "RAW_MISSING", details: { echoed: "safe" } },
      }),
    };

    const outcome = createToolResultPipeline({ sanitizer: sanitizer as never }).process({
      call,
      invocation,
      rawResult: { content: "safe", details: { echoed: "safe" }, isError: false },
      now: NOW,
    });
    expectOutputFailure(outcome);
    expect(JSON.stringify(outcome)).not.toContain("RAW_MISSING");
  });

  it("materializes a sanitized details-budget violation as a safe Tool failure", () => {
    const { call, invocation } = fixture();
    const sanitizer = {
      sanitize: () => ({
        kind: "SANITIZED",
        result: { content: "safe", details: { echoed: "a".repeat(200) }, isError: false },
      }),
    };

    const outcome = createToolResultPipeline({
      sanitizer: sanitizer as never,
      limits: { maxDurableContentBytes: 4096, maxDetailsBytes: 32 },
    }).process({
      call,
      invocation,
      rawResult: { content: "safe", details: { echoed: "safe" }, isError: false },
      now: NOW,
    });
    expectOutputFailure(outcome);
  });

  it("turns a sanitizer throw into a safe Tool failure without exposing its cause", () => {
    const { call, invocation } = fixture();
    const sanitizer = {
      sanitize: () => {
        throw new Error("SECRET_TOKEN_12345678 C:\\Users\\alice\\repo\\file.ts STACK_MARKER");
      },
    };

    const outcome = createToolResultPipeline({ sanitizer: sanitizer as never }).process({
      call,
      invocation,
      rawResult: { content: "secret-bearing", details: { echoed: "safe" }, isError: false },
      now: NOW,
    });
    const failure = expectOutputFailure(outcome);
    expect(JSON.stringify(failure)).not.toContain("secret-bearing");
    expect(JSON.stringify(failure)).not.toContain("SECRET_TOKEN_12345678");
    expect(JSON.stringify(failure)).not.toContain("C:\\\\Users");
    expect(JSON.stringify(failure)).not.toContain("STACK_MARKER");
  });

  it.each(["SCAN_NODE_LIMIT", "SCAN_DEPTH_LIMIT", "TEXT_LIMIT"] as const)(
    "materializes sanitizer refusal %s with only its safe reason",
    (reason) => {
      const { call, invocation } = fixture();
      const sanitizer = { sanitize: () => ({ kind: "REFUSED", reason }) };
      const outcome = createToolResultPipeline({ sanitizer: sanitizer as never }).process({
        call,
        invocation,
        rawResult: { content: "RAW_RESULT", details: { echoed: "safe" }, isError: false },
        now: NOW,
      });
      const failure = expectOutputFailure(outcome);
      expect(failure.failure.feedback.details).toMatchObject({ reason });
      expect(JSON.stringify(failure)).not.toContain("RAW_RESULT");
    },
  );

  it("does not copy an unrecognized sanitizer refusal reason into feedback", () => {
    const { call, invocation } = fixture();
    const sanitizer = { sanitize: () => ({ kind: "REFUSED", reason: "SECRET_RAW_REASON" }) };
    const outcome = createToolResultPipeline({ sanitizer: sanitizer as never }).process({
      call,
      invocation,
      rawResult: { content: "safe", details: { echoed: "safe" }, isError: false },
      now: NOW,
    });

    const failure = expectOutputFailure(outcome);
    expect(failure.failure.feedback.details).toEqual({});
    expect(JSON.stringify(failure)).not.toContain("SECRET_RAW_REASON");
  });
});

describe("ToolSettlementExtension", () => {
  it("passes an opaque extension through without interpreting it", () => {
    const { call, invocation } = fixture();
    const extension: ToolSettlementExtension = {
      kind: "some.overlay.v9",
      payload: { anything: [1, 2, 3] },
    };
    const projector: ToolSettlementExtensionProjector = () => extension;

    const outcome = createToolResultPipeline({ settlementExtension: projector }).process({
      call,
      invocation,
      rawResult: { content: "safe", details: { echoed: "safe" }, isError: false },
      now: NOW,
    });

    const settlement = acceptedSettlement(outcome);
    expect(settlement.effects).toEqual(extension);
    expect(Object.isFrozen(settlement.effects)).toBe(true);
  });

  it("sees only the sanitized, final result and the frozen call", () => {
    const { call, invocation } = fixture();
    const seen: { content?: string; details?: JsonObject; now?: number } = {};
    const sanitizer: ToolResultSanitizerPort = {
      sanitize: () => ({
        kind: "SANITIZED",
        result: { content: "SANITIZED", details: { echoed: "sanitized" }, isError: false },
      }),
    };
    const projector: ToolSettlementExtensionProjector = ({ result, now }) => {
      seen.content = result.content;
      seen.details = result.details;
      seen.now = now;
      return undefined;
    };

    createToolResultPipeline({ sanitizer, settlementExtension: projector }).process({
      call,
      invocation,
      rawResult: { content: "RAW", details: { echoed: "raw" }, isError: false },
      now: NOW,
    });

    expect(seen.content).toBe("SANITIZED");
    expect(seen.details).toEqual({ echoed: "sanitized" });
    expect(seen.now).toBe(NOW);
  });

  it("turns an extension projector throw into an unknown side-effect failure", () => {
    const { call, invocation } = fixture();
    const projector: ToolSettlementExtensionProjector = () => {
      throw new Error("effect projection failed");
    };

    const outcome = createToolResultPipeline({ settlementExtension: projector }).process({
      call,
      invocation,
      rawResult: { content: "safe", details: { echoed: "safe" }, isError: false },
      now: NOW,
    });
    expect(outcome).toMatchObject({
      kind: "FAILED",
      failure: {
        error: { code: "TOOL_OUTCOME_UNKNOWN" },
        feedback: { disposition: "UNCERTAIN_SIDE_EFFECT", blockToolFailures: true },
      },
    });
  });
});

describe("ToolResultLimits and the standalone helpers", () => {
  it("keeps the frozen default budgets", () => {
    expect(DEFAULT_TOOL_RESULT_LIMITS).toEqual({
      maxDurableContentBytes: 64 * 1024,
      maxDetailsBytes: 256 * 1024,
    });
  });

  it("refuses a non-positive or non-integer budget", () => {
    for (const limits of [
      { maxDurableContentBytes: 0, maxDetailsBytes: 10 },
      { maxDurableContentBytes: 10, maxDetailsBytes: 0 },
      { maxDurableContentBytes: 1.5, maxDetailsBytes: 10 },
      { maxDurableContentBytes: Number.NaN, maxDetailsBytes: 10 },
    ]) {
      expect(() => validateToolResultLimits(limits)).toThrowError(ToolResultLimitError);
      expect(() => createToolResultPipeline({ limits })).toThrowError(ToolResultLimitError);
    }
  });

  it("keeps the exact byte boundary, the marker and the no-marker fallback", () => {
    expect(
      boundToolResultContent("hello", { maxDurableContentBytes: 5, maxDetailsBytes: 10 }),
    ).toBe("hello");
    expect(boundToolResultContent("中文", { maxDurableContentBytes: 3, maxDetailsBytes: 10 })).toBe(
      "中",
    );
    expect(boundToolResultContent("中文", { maxDurableContentBytes: 1, maxDetailsBytes: 10 })).toBe(
      "",
    );
  });

  it("validates a result through the standalone entry point", () => {
    const { call } = fixture();
    const validated = validateToolResult({
      value: { content: "safe", details: { echoed: "safe" }, isError: false },
      resolved: call.resolved,
      limits: DEFAULT_TOOL_RESULT_LIMITS,
    });

    expect(validated).toEqual({ content: "safe", details: { echoed: "safe" }, isError: false });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.details)).toBe(true);
    expect(isAgentToolResult(validated)).toBe(true);
    expect(readResultShape(validated).content).toBe("safe");
  });

  it("does not mutate the raw producer value and is not changed by it", () => {
    const { call } = fixture();
    const raw = { content: "safe", details: { echoed: "safe" }, isError: false };

    const validated = validateToolResult({
      value: raw,
      resolved: call.resolved,
      limits: DEFAULT_TOOL_RESULT_LIMITS,
    });

    // The validated value is frozen...
    expect(() => {
      (validated.details as { echoed: string }).echoed = "changed";
    }).toThrow();
    // ...and it holds its own copy, so mutating the producer's object afterwards changes nothing.
    raw.details.echoed = "mutated by the producer";
    expect(validated.details).toEqual({ echoed: "safe" });
  });
});
