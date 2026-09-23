import {
  createObservationId,
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  type ToolObservation,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import {
  AgentToolResultBatchError,
  createModelToolFeedbackProjector,
  createToolResultBatchNormalizer,
  MODEL_FEEDBACK_TRUNCATION_MARKER,
  type ModelObservationBatchProjector,
  type ModelObservationCandidate,
  type ModelToolFeedbackProjector,
  type ToolBatchItemOutcome,
  type ToolCallRequest,
  type ToolObservationPolicySnapshot,
} from "../src/index.js";

/**
 * The canonical Model Tool Feedback Projector.
 *
 * ```text
 * durable ToolObservation  +  safe ToolFailureFeedback
 *        ↓
 * AIToolResultMessage[]    exactly one per original call, in original order, bounded
 * ```
 *
 * The projector's token-projection algorithm is injected, so these tests observe the *semantics* the
 * Agent package owns: identity, order, completeness, `isError`, and what may and may not be an input.
 * Truncation behaviour is asserted through an explicit projection double and through the built-in
 * fallback budget.
 */

const GENEROUS: ToolObservationPolicySnapshot = {
  maxSingleObservationTokens: 4_000,
  maxObservationBatchTokens: 12_000,
};

function modelMessages(
  projector: ModelToolFeedbackProjector,
  input: {
    readonly calls: readonly ToolCallRequest[];
    readonly items: readonly ToolBatchItemOutcome[];
    readonly policy: ToolObservationPolicySnapshot;
  },
): readonly import("@caelush/ai").AIToolResultMessage[] {
  return projector.project(input).map((projected) => projected.message);
}

function call(externalCallId: string, toolName = "read_file"): ToolCallRequest {
  return { externalCallId, toolName, args: { path: "a.ts" } };
}

function observation(content: string, isError = false, rawArtifactRef?: string): ToolObservation {
  return {
    id: createObservationId(),
    runId: createRunId(),
    stepId: createStepId(),
    kind: "TOOL",
    toolInvocationId: createToolInvocationId(),
    ...(rawArtifactRef === undefined ? {} : { rawArtifactRef }),
    content,
    isError,
    createdAt: createTimestampMs(1),
  } as ToolObservation;
}

function observed(
  request: ToolCallRequest,
  content: string,
  isError = false,
  rawArtifactRef?: string,
): ToolBatchItemOutcome {
  return {
    kind: "OBSERVATION",
    call: request,
    invocationId: createToolInvocationId(),
    finalStatus: isError ? "FAILED" : "COMPLETED",
    observation: observation(content, isError, rawArtifactRef),
  };
}

function rejected(
  request: ToolCallRequest,
  content = "Correct the arguments.",
): ToolBatchItemOutcome {
  return {
    kind: "REJECTED",
    call: request,
    feedback: {
      code: "TOOL_ARGUMENT_ERROR",
      content,
      details: {},
      disposition: "SAFE_FAILURE",
    },
  };
}

function skipped(
  request: ToolCallRequest,
  content = "Re-inspect the state.",
): ToolBatchItemOutcome {
  return {
    kind: "SKIPPED",
    call: request,
    feedback: {
      code: "SKIPPED_AFTER_UNCERTAIN_EXECUTION",
      content,
      details: {},
      disposition: "UNCERTAIN_SIDE_EFFECT",
    },
  };
}

/** A projection double that records the candidates it was handed. */
function recordingProjection(): ModelObservationBatchProjector & {
  readonly seen: readonly ModelObservationCandidate[][];
  readonly policies: readonly ToolObservationPolicySnapshot[];
} {
  const seen: ModelObservationCandidate[][] = [];
  const policies: ToolObservationPolicySnapshot[] = [];
  return {
    seen,
    policies,
    projectBatch(input) {
      seen.push([...input.candidates]);
      policies.push(input.policy);
      return input.candidates.map((candidate) => `[projected] ${candidate.content}`);
    },
  };
}

describe("canonical model feedback — identity and order", () => {
  it("produces one message per original call, in original order", () => {
    const projector = createModelToolFeedbackProjector();
    const calls = [call("call_1"), call("call_2"), call("call_3")];
    const messages = modelMessages(projector, {
      calls,
      items: [observed(calls[0]!, "one"), rejected(calls[1]!), skipped(calls[2]!)],
      policy: GENEROUS,
    });

    expect(messages).toEqual([
      {
        role: "tool",
        toolCallId: "call_1",
        toolName: "read_file",
        content: "one",
        isError: false,
      },
      {
        role: "tool",
        toolCallId: "call_2",
        toolName: "read_file",
        content: "Correct the arguments.",
        isError: true,
      },
      {
        role: "tool",
        toolCallId: "call_3",
        toolName: "read_file",
        content: "Re-inspect the state.",
        isError: true,
      },
    ]);
  });

  it("takes identity from the original call, never from the content", () => {
    const projector = createModelToolFeedbackProjector();
    const calls = [call("call_a", "exec_command")];
    const messages = modelMessages(projector, {
      // The observation's own content names a different call entirely: identity must not be parsed.
      calls,
      items: [observed(calls[0]!, "toolCallId: call_something_else")],
      policy: GENEROUS,
    });
    expect(messages[0]!.toolCallId).toBe("call_a");
    expect(messages[0]!.toolName).toBe("exec_command");
  });

  it("preserves the observation's own isError and the failure arms' true", () => {
    const projector = createModelToolFeedbackProjector();
    const calls = [call("ok"), call("bad"), call("rej"), call("skip")];
    const messages = modelMessages(projector, {
      calls,
      items: [
        observed(calls[0]!, "fine", false),
        observed(calls[1]!, "failed", true),
        rejected(calls[2]!),
        skipped(calls[3]!),
      ],
      policy: GENEROUS,
    });
    expect(messages.map((message) => message.isError)).toEqual([false, true, true, true]);
  });

  it("returns nothing for an empty batch", () => {
    const projector = createModelToolFeedbackProjector();
    expect(modelMessages(projector, { calls: [], items: [], policy: GENEROUS })).toEqual([]);
  });

  it("returns a SNAPSHOT receipt over the exact projected message", () => {
    const projector = createModelToolFeedbackProjector();
    const calls = [call("call_a")];
    const first = projector.project({
      calls,
      items: [observed(calls[0]!, "one")],
      policy: GENEROUS,
    });
    const second = projector.project({
      calls,
      items: [observed(calls[0]!, "one")],
      policy: GENEROUS,
    });

    expect(first[0]?.receipt.policy).toEqual({ kind: "SNAPSHOT", snapshot: GENEROUS });
    expect(first[0]?.receipt.version).toBe(1);
    expect(first[0]?.receipt.fingerprint).toBeDefined();
    expect(first[0]?.message.content).toBe("one");
    expect(first[0]?.receipt.fingerprint).toBe(second[0]?.receipt.fingerprint);
  });
});

describe("canonical model feedback — the raw result never enters", () => {
  it("carries no rawArtifactRef, invocationId or details field", () => {
    const projector = createModelToolFeedbackProjector();
    const calls = [call("call_a")];
    const messages = modelMessages(projector, {
      calls,
      items: [observed(calls[0]!, "body", false, "artifact:raw-1")],
      policy: GENEROUS,
    });

    // The frozen AI contract has exactly five fields. A raw artifact pointer is a durable recovery
    // plane fact, not something the model is told.
    expect(Object.keys(messages[0]!).sort()).toEqual([
      "content",
      "isError",
      "role",
      "toolCallId",
      "toolName",
    ]);
    expect(JSON.stringify(messages)).not.toContain("artifact:raw-1");
    expect(JSON.stringify(messages)).not.toContain("invocation");
  });

  it("passes the artifact pointer to the projection, because Context recovery needs it", () => {
    const projection = recordingProjection();
    const projector = createModelToolFeedbackProjector({ projection });
    const calls = [call("call_a")];
    projector.project({
      calls,
      items: [observed(calls[0]!, "body", false, "artifact:raw-1")],
      policy: GENEROUS,
    });

    // The projection boundary is not model-facing: it is where the token budget is applied, and the
    // archive locator travels with the candidate so a forced Context recovery can reach the original.
    expect(projection.seen[0]![0]!.rawArtifactRef).toBe("artifact:raw-1");
  });

  it("has no arm that could carry an execution result or a transient update", async () => {
    // A declaration-level check: the three arms are the closed set, and none of them has a field for a
    // raw `AgentToolResult`, a `ToolExecutionUpdate`, an exception or a Tool effect.
    const arms: readonly ToolBatchItemOutcome["kind"][] = ["OBSERVATION", "REJECTED", "SKIPPED"];
    expect(arms).toHaveLength(3);

    // And the projector's declared input names only durable observations and safe feedback: the type
    // of `items` is `ToolBatchItemOutcome[]`, and no raw execution result is reachable from it. This is
    // read from the *declaration*, because the runtime snapshot of a function also contains the names of
    // the errors it throws.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../src/tools/observation/model-feedback-projector.ts", import.meta.url),
      "utf8",
    );
    const declaration = source.slice(
      source.indexOf("export interface ModelToolFeedbackProjector"),
      source.indexOf("export interface ModelObservationCandidate"),
    );
    expect(declaration).toContain("readonly items: readonly ToolBatchItemOutcome[]");
    expect(declaration).toContain("readonly calls: readonly ToolCallRequest[]");
    for (const forbidden of [
      "AgentToolResult",
      "ToolExecutionUpdate",
      "ToolEffect",
      "stdout",
      "stderr",
    ]) {
      expect(declaration, `the projector input must not name ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });
});

describe("canonical model feedback — integrity", () => {
  it("refuses a missing item", () => {
    const projector = createModelToolFeedbackProjector();
    expect(() =>
      projector.project({
        calls: [call("call_a"), call("call_b")],
        items: [observed(call("call_a"), "one")],
        policy: GENEROUS,
      }),
    ).toThrow(AgentToolResultBatchError);
  });

  it("refuses a foreign item", () => {
    const projector = createModelToolFeedbackProjector();
    expect(() =>
      projector.project({
        calls: [call("call_a")],
        items: [observed(call("call_other"), "one")],
        policy: GENEROUS,
      }),
    ).toThrow(AgentToolResultBatchError);
  });

  it("refuses a duplicate item", () => {
    const projector = createModelToolFeedbackProjector();
    const request = call("call_a");
    expect(() =>
      projector.project({
        calls: [request, request],
        items: [observed(request, "one"), observed(request, "one")],
        policy: GENEROUS,
      }),
    ).toThrow(AgentToolResultBatchError);
  });

  it("refuses an item whose position does not match the call order", () => {
    const projector = createModelToolFeedbackProjector();
    const first = call("call_a");
    const second = call("call_b");
    expect(() =>
      projector.project({
        calls: [first, second],
        items: [observed(second, "b"), observed(first, "a")],
        policy: GENEROUS,
      }),
    ).toThrow(AgentToolResultBatchError);
  });

  it("refuses a Tool-name mismatch on an otherwise matching call", () => {
    const projector = createModelToolFeedbackProjector();
    expect(() =>
      projector.project({
        calls: [call("call_a", "read_file")],
        items: [observed(call("call_a", "exec_command"), "one")],
        policy: GENEROUS,
      }),
    ).toThrow(AgentToolResultBatchError);
  });

  it("refuses a projection that returns a different number of summaries", () => {
    const projector = createModelToolFeedbackProjector({
      projection: {
        projectBatch() {
          // One candidate in, zero summaries out: a pairing would attach one Tool's output to another
          // Tool's identity, so this fails closed.
          return [];
        },
      },
    });
    expect(() =>
      projector.project({
        calls: [call("call_a")],
        items: [observed(call("call_a"), "one")],
        policy: GENEROUS,
      }),
    ).toThrow(AgentToolResultBatchError);
  });

  it("refuses an unusable observation policy", () => {
    const projector = createModelToolFeedbackProjector();
    for (const policy of [
      { maxSingleObservationTokens: 0, maxObservationBatchTokens: 10 },
      { maxSingleObservationTokens: 10, maxObservationBatchTokens: 0 },
      { maxSingleObservationTokens: 1.5, maxObservationBatchTokens: 10 },
    ]) {
      expect(() =>
        projector.project({
          calls: [call("call_a")],
          items: [observed(call("call_a"), "one")],
          policy,
        }),
      ).toThrow(RangeError);
    }
  });
});

describe("canonical model feedback — the injection seam", () => {
  it("hands the projection the candidates in call order and the exact policy", () => {
    const projection = recordingProjection();
    const projector = createModelToolFeedbackProjector({ projection });
    const calls = [call("call_1", "read_file"), call("call_2", "exec_command")];
    projector.project({
      calls,
      items: [observed(calls[0]!, "first"), rejected(calls[1]!, "second")],
      policy: { maxSingleObservationTokens: 111, maxObservationBatchTokens: 222 },
    });

    // One call for the whole batch, so the batch budget is allocated across every Tool Result —
    // including the ones that never executed.
    expect(projection.seen).toHaveLength(1);
    expect(projection.seen[0]!.map((candidate) => candidate.toolName)).toEqual([
      "read_file",
      "exec_command",
    ]);
    expect(projection.seen[0]!.map((candidate) => candidate.content)).toEqual(["first", "second"]);
    expect(projection.policies).toEqual([
      { maxSingleObservationTokens: 111, maxObservationBatchTokens: 222 },
    ]);
  });

  it("uses the projection's bounded summaries verbatim", () => {
    const projector = createModelToolFeedbackProjector({
      projection: {
        projectBatch: ({ candidates }) => candidates.map(() => "bounded"),
      },
    });
    const calls = [call("call_a")];
    const messages = modelMessages(projector, {
      calls,
      items: [observed(calls[0]!, "x".repeat(100_000))],
      policy: GENEROUS,
    });
    expect(messages[0]!.content).toBe("bounded");
  });

  it("turns a projection dependency failure into an infrastructure failure, not a Tool error", () => {
    const projector = createModelToolFeedbackProjector({
      projection: {
        projectBatch() {
          throw new Error("estimator unavailable");
        },
      },
    });
    const calls = [call("call_a")];
    const failure = (() => {
      try {
        projector.project({ calls, items: [observed(calls[0]!, "one")], policy: GENEROUS });
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    // A model told "your Tool result could not be rendered" would treat a host bug as a Tool failure
    // and retry the call, so this is never an `AIToolResultMessage` with `isError: true`.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AgentToolResultBatchError);
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });
});

describe("canonical model feedback — the fallback budget", () => {
  it("bounds a single oversized observation", () => {
    const projector = createModelToolFeedbackProjector();
    const calls = [call("call_a")];
    const messages = modelMessages(projector, {
      calls,
      items: [observed(calls[0]!, "x".repeat(40_000))],
      policy: { maxSingleObservationTokens: 100, maxObservationBatchTokens: 1_000 },
    });

    expect(messages[0]!.content.length).toBeLessThan(40_000);
    expect(messages[0]!.content).toContain(MODEL_FEEDBACK_TRUNCATION_MARKER);
    // The bound is a token budget, and the fallback estimator is the same UTF-8 byte heuristic the
    // Context estimator uses, so 100 tokens is at most 300 bytes of content.
    expect(Buffer.byteLength(messages[0]!.content, "utf8")).toBeLessThan(100 * 3 + 64);
  });

  it("bounds the whole batch, preserving a representation for every Tool Result", () => {
    const projector = createModelToolFeedbackProjector();
    const calls = [call("call_a"), call("call_b"), call("call_c")];
    const messages = modelMessages(projector, {
      calls,
      items: calls.map((request) => observed(request, "y".repeat(20_000))),
      policy: { maxSingleObservationTokens: 200, maxObservationBatchTokens: 300 },
    });

    expect(messages).toHaveLength(3);
    for (const message of messages) {
      // Every result keeps a non-empty representation: the batch budget is shared, never exhausted by
      // the first item.
      expect(message.content.length).toBeGreaterThan(0);
      expect(message.content).toContain(MODEL_FEEDBACK_TRUNCATION_MARKER);
    }
  });

  it("bounds safe feedback exactly like an observation", () => {
    const projector = createModelToolFeedbackProjector();
    const calls = [call("call_a")];
    const messages = modelMessages(projector, {
      calls,
      items: [rejected(calls[0]!, "z".repeat(40_000))],
      policy: { maxSingleObservationTokens: 50, maxObservationBatchTokens: 200 },
    });

    // "Safe" is not the same as "short": an unbounded rejection message would still blow the window.
    expect(messages[0]!.content.length).toBeLessThan(40_000);
    expect(messages[0]!.content).toContain(MODEL_FEEDBACK_TRUNCATION_MARKER);
    expect(messages[0]!.isError).toBe(true);
  });

  it("does not split a multibyte code point", () => {
    const projector = createModelToolFeedbackProjector();
    const calls = [call("call_a")];
    const messages = modelMessages(projector, {
      // Astral code points, so a naive byte or UTF-16 slice would produce a lone surrogate.
      calls,
      items: [observed(calls[0]!, "🙂".repeat(20_000))],
      policy: { maxSingleObservationTokens: 40, maxObservationBatchTokens: 100 },
    });

    const content = messages[0]!.content;
    // A lone surrogate would make the string round-trip through UTF-8 lossily.
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
    expect(content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(content).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(content.startsWith("🙂")).toBe(true);
  });

  it("refuses a batch budget smaller than the number of Tool Results", () => {
    const projector = createModelToolFeedbackProjector();
    const calls = [call("call_a"), call("call_b")];
    expect(() =>
      projector.project({
        calls,
        items: calls.map((request) => observed(request, "one")),
        // Fewer tokens than results: no allocation can preserve every Tool Result.
        policy: { maxSingleObservationTokens: 10, maxObservationBatchTokens: 1 },
      }),
    ).toThrow(RangeError);
  });

  it("leaves content that already fits exactly as it is", () => {
    const projector: ModelToolFeedbackProjector = createModelToolFeedbackProjector();
    const calls = [call("call_a")];
    const messages = modelMessages(projector, {
      calls,
      items: [observed(calls[0]!, "short body")],
      policy: GENEROUS,
    });
    expect(messages[0]!.content).toBe("short body");
  });
});

describe("canonical model feedback — normalize composes with project", () => {
  it("produces a batch the normalizer accepts, in original order", () => {
    const projector = createModelToolFeedbackProjector();
    const normalizer = createToolResultBatchNormalizer();
    const calls = [call("call_3"), call("call_1"), call("call_2")];
    const projected = projector.project({
      calls,
      items: calls.map((request) => observed(request, request.externalCallId)),
      policy: GENEROUS,
    });

    // The projector preserves the *call* order it was given, which is assistant source order.
    expect(projected.map(({ message }) => message.toolCallId)).toEqual([
      "call_3",
      "call_1",
      "call_2",
    ]);
    // And the normalizer restores that same order from a result list that arrives out of order,
    // which is the provider completion-order defense.
    const normalized = normalizer.normalize({
      requests: calls,
      results: [projected[2]!.message, projected[0]!.message, projected[1]!.message],
    });
    expect(normalized.map((message) => message.toolCallId)).toEqual(["call_3", "call_1", "call_2"]);
  });
});
