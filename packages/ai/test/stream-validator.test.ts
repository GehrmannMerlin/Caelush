import { describe, expect, it } from "vitest";
import { AIError } from "../src/errors/ai-error.js";
import { createLLMCallId } from "../src/ids/llm-call-id.js";
import { createStreamValidator } from "../src/stream/stream-validator.js";
import type { AIStreamEvent } from "../src/stream/events.js";

/** Build a valid public stream event sequence. */
function start(): AIStreamEvent {
  return {
    type: "stream.start",
    payload: {
      callId: createLLMCallId(),
      providerId: "test",
      model: { provider: "test", model: "model-a" },
      resolution: {
        api: "test-api",
        reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
        cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
      },
    },
  };
}

function text(value = "hello"): AIStreamEvent {
  return { type: "text.delta", payload: { text: value } };
}

function summary(value = "thinking"): AIStreamEvent {
  return { type: "reasoning.summary.delta", payload: { text: value } };
}

function toolStart(id = "c1", name = "read_file"): AIStreamEvent {
  return { type: "tool_call.start", payload: { toolCallId: id, toolName: name } };
}

function toolDelta(id = "c1"): AIStreamEvent {
  return { type: "tool_call.delta", payload: { toolCallId: id, delta: '{"path"' } };
}

function toolCompleted(id = "c1", name = "read_file"): AIStreamEvent {
  return {
    type: "tool_call.completed",
    payload: { id, name, input: { path: "a.ts" } },
  };
}

function usage(): AIStreamEvent {
  return { type: "usage", payload: { inputTokens: 3 } };
}

function finish(): AIStreamEvent {
  return { type: "stream.finish", payload: { finishReason: "STOP" } };
}

function error(): AIStreamEvent {
  return {
    type: "stream.error",
    payload: { error: { code: "AI_NETWORK", message: "reset", retryable: true } },
  };
}

/** Feed a sequence and require the first rejected event to be `index`. */
function expectRejectedAt(events: readonly AIStreamEvent[], index: number): void {
  const validator = createStreamValidator();
  events.forEach((event, position) => {
    if (position < index) {
      validator.accept(event);
      return;
    }
    try {
      validator.accept(event);
      expect.unreachable(`expected event ${String(position)} to be rejected`);
    } catch (caught) {
      expect(caught).toBeInstanceOf(AIError);
      expect((caught as AIError).code).toBe("AI_INVALID_RESPONSE");
      expect((caught as AIError).retryable).toBe(false);
    }
  });
}

describe("StreamValidator acceptance", () => {
  it("accepts the success lifecycle", () => {
    const validator = createStreamValidator();

    for (const event of [
      start(),
      text("a"),
      summary("s"),
      toolStart(),
      toolDelta(),
      toolCompleted(),
      usage(),
      text("b"),
      finish(),
    ]) {
      validator.accept(event);
    }

    expect(validator.currentState()).toBe("FINISHED");
    expect(() => {
      validator.assertFinished();
    }).not.toThrow();
  });

  it("accepts a finish with no content", () => {
    const validator = createStreamValidator();
    validator.accept(start());
    validator.accept(finish());

    expect(validator.currentState()).toBe("FINISHED");
  });

  it("accepts the runtime-failure lifecycle and allows an open tool call", () => {
    const validator = createStreamValidator();
    validator.accept(start());
    validator.accept(text());
    validator.accept(toolStart());
    validator.accept(toolDelta());
    validator.accept(error());

    expect(validator.currentState()).toBe("ERRORED");
    expect(validator.openToolCallIds()).toEqual(["c1"]);
  });
});

describe("StreamValidator envelope violations", () => {
  it("rejects a double start", () => {
    expectRejectedAt([start(), start()], 1);
  });

  it("rejects any content before start", () => {
    for (const first of [text(), summary(), toolStart(), usage(), finish(), error()]) {
      expectRejectedAt([first], 0);
    }
  });

  it("rejects a double finish and a finish after error", () => {
    expectRejectedAt([start(), finish(), finish()], 2);
    expectRejectedAt([start(), error(), finish()], 2);
  });

  it("rejects a double error and an error after finish", () => {
    expectRejectedAt([start(), error(), error()], 2);
    expectRejectedAt([start(), finish(), error()], 2);
  });

  it("rejects any event after a terminal event", () => {
    expectRejectedAt([start(), finish(), text()], 2);
    expectRejectedAt([start(), finish(), toolStart()], 2);
    expectRejectedAt([start(), finish(), usage()], 2);
    expectRejectedAt([start(), error(), text()], 2);
    expectRejectedAt([start(), error(), usage()], 2);
  });

  it("reports assertFinished when the stream never terminated", () => {
    const validator = createStreamValidator();
    validator.accept(start());
    validator.accept(text());

    expect(validator.currentState()).toBe("STARTED");
    expect(() => {
      validator.assertFinished();
    }).toThrow(AIError);

    const untouched = createStreamValidator();
    expect(untouched.currentState()).toBe("NOT_STARTED");
    expect(() => {
      untouched.assertFinished();
    }).toThrow(AIError);
  });
});

describe("StreamValidator tool call lifecycle", () => {
  it("rejects a duplicate tool call id", () => {
    expectRejectedAt([start(), toolStart("c1"), toolStart("c1")], 2);
    expectRejectedAt([start(), toolStart("c1"), toolCompleted("c1"), toolStart("c1")], 3);
  });

  it("rejects a delta for an inactive tool call", () => {
    expectRejectedAt([start(), toolDelta("c1")], 1);
    expectRejectedAt([start(), toolStart("c1"), toolDelta("c2")], 2);
    expectRejectedAt([start(), toolStart("c1"), toolCompleted("c1"), toolDelta("c1")], 3);
  });

  it("rejects a completion for an inactive tool call", () => {
    expectRejectedAt([start(), toolCompleted("c1")], 1);
    expectRejectedAt([start(), toolStart("c1"), toolCompleted("c2")], 2);
    expectRejectedAt([start(), toolStart("c1"), toolCompleted("c1"), toolCompleted("c1")], 3);
  });

  it("rejects a tool name mutation", () => {
    expectRejectedAt([start(), toolStart("c1", "read_file"), toolCompleted("c1", "write_file")], 2);
  });

  it("rejects a success finish that leaves a tool call open", () => {
    expectRejectedAt([start(), toolStart("c1"), finish()], 2);
    expectRejectedAt([start(), toolStart("c1"), toolDelta("c1"), finish()], 3);
    expectRejectedAt([start(), toolStart("c1"), toolCompleted("c1"), toolStart("c2"), finish()], 4);
  });

  it("allows a completed tool call before a success finish", () => {
    const validator = createStreamValidator();
    for (const event of [
      start(),
      toolStart("c1"),
      toolDelta("c1"),
      toolCompleted("c1"),
      finish(),
    ]) {
      validator.accept(event);
    }

    expect(validator.currentState()).toBe("FINISHED");
    expect(validator.openToolCallIds()).toEqual([]);
  });
});
