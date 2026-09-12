import { createAIError } from "../errors/ai-error.js";
import { createToolCallTracker } from "./tool-call-tracker.js";
import type { AIErrorContext } from "../errors/ai-error.js";
import type { AIStreamEvent } from "./events.js";
import type { ToolCallTracker } from "./tool-call-tracker.js";

/**
 * The frozen stream lifecycle states.
 *
 * ```text
 * NOT_STARTED → STARTED → FINISHED
 *                      ↘ ERRORED
 * ```
 */
export type AIStreamState = "NOT_STARTED" | "STARTED" | "FINISHED" | "ERRORED";

/**
 * Validates one public AI stream event sequence.
 *
 * The validator is the runtime half of the stream contract: it enforces that
 * `stream.start` happens exactly once and first, that content only follows it,
 * that exactly one terminal event closes the stream, that a tool-call lifecycle is
 * coherent, and that a successful finish leaves no tool call open.
 *
 * It never repairs a violation. A malformed sequence fails closed, because
 * silently fixing a broken stream would hide the defect that produced it.
 */
export interface StreamValidator {
  /** Accept one event, or throw `AI_INVALID_RESPONSE`. */
  accept(event: AIStreamEvent): void;
  currentState(): AIStreamState;
  /** Ids announced but never completed, in announcement order. */
  openToolCallIds(): readonly string[];
  /** Throw unless the stream reached `stream.finish`. */
  assertFinished(): void;
}

/**
 * Create a validator.
 *
 * The optional expected identity lets a caller bind the sequence to a selected
 * call, so a stream that announces a different call, provider or model is
 * rejected rather than trusted.
 */
export function createStreamValidator(expected?: {
  readonly callId?: string;
  readonly providerId?: string;
  readonly model?: { readonly provider: string; readonly model: string };
}): StreamValidator {
  let state: AIStreamState = "NOT_STARTED";
  let context: AIErrorContext = {};
  const tracker: ToolCallTracker = createToolCallTracker();

  const fail = (message: string): never => {
    throw createAIError("AI_INVALID_RESPONSE", message, context);
  };

  const assertStartedContent = (): void => {
    if (state === "NOT_STARTED") {
      fail("AI stream emitted an event before stream.start.");
    }
    if (state === "FINISHED" || state === "ERRORED") {
      fail(`AI stream emitted an event after it terminated as ${state.toLowerCase()}.`);
    }
  };

  return {
    accept(event: AIStreamEvent): void {
      if (event.type === "stream.start") {
        if (state !== "NOT_STARTED") {
          fail("AI stream must emit stream.start exactly once.");
        }
        const { callId, providerId, model } = event.payload;
        context = { providerId, model };

        if (expected?.callId !== undefined && callId !== expected.callId) {
          fail("AI stream.start call id does not match the gateway call.");
        }
        if (expected?.providerId !== undefined && providerId !== expected.providerId) {
          fail("AI stream.start provider id does not match the selected provider.");
        }
        if (
          expected?.model !== undefined &&
          (model.provider !== expected.model.provider || model.model !== expected.model.model)
        ) {
          fail("AI stream.start model does not match the request model.");
        }

        state = "STARTED";
        return;
      }

      assertStartedContent();

      switch (event.type) {
        case "stream.finish": {
          const open = tracker.openIds();
          if (open.length > 0) {
            fail(`AI stream.finish cannot close the open tool call "${open[0] ?? ""}".`);
          }
          state = "FINISHED";
          return;
        }
        case "stream.error":
          // A failed stream may legitimately leave a partially received tool call
          // open. The partial call simply never reaches a turn result.
          state = "ERRORED";
          return;
        case "tool_call.start":
          tracker.start(event.payload.toolCallId, event.payload.toolName, context);
          return;
        case "tool_call.delta":
          tracker.delta(event.payload.toolCallId, context);
          return;
        case "tool_call.completed":
          tracker.complete(event.payload.id, event.payload.name, context);
          return;
        default:
          // text.delta, reasoning.summary.delta and usage carry no lifecycle state.
          return;
      }
    },

    currentState(): AIStreamState {
      return state;
    },

    openToolCallIds(): readonly string[] {
      return tracker.openIds();
    },

    assertFinished(): void {
      if (state !== "FINISHED") {
        fail(
          state === "ERRORED"
            ? "AI stream failed and produced no turn result."
            : "AI stream ended without stream.finish.",
        );
      }
    },
  };
}
