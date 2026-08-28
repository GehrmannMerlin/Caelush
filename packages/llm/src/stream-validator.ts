import type { LLMCallId, ModelRef } from "@caelush/protocol";
import { LLMInvalidResponseError } from "./errors.js";
import type { LLMStreamEvent } from "./events.js";

type StreamState = "NOT_STARTED" | "STARTED" | "FINISHED";
type ToolState = "STARTED" | "COMPLETED";
interface ToolLifecycle {
  state: ToolState;
  name: string;
}

interface StreamValidator {
  accept(event: LLMStreamEvent): void;
  assertFinished(): void;
}

export function createStreamValidator(
  expectedCallId: LLMCallId,
  expectedProviderId: string,
  expectedModel: ModelRef,
): StreamValidator {
  let streamState: StreamState = "NOT_STARTED";
  const toolStates = new Map<string, ToolLifecycle>();
  const fail = (message: string): never => {
    throw new LLMInvalidResponseError(message, {
      providerId: expectedProviderId,
      model: expectedModel,
    });
  };

  const assertStarted = (): void => {
    if (streamState === "NOT_STARTED") {
      fail("LLM provider stream emitted an event before stream.start.");
    }
    if (streamState === "FINISHED") {
      fail("LLM provider stream emitted an event after stream.finish.");
    }
  };

  return {
    accept(event): void {
      if (event.type === "stream.start") {
        if (streamState !== "NOT_STARTED") {
          fail("LLM provider stream must emit stream.start exactly once.");
        }
        const { callId, providerId, model } = event.payload;
        if (callId !== expectedCallId) {
          fail("LLM provider stream.start call id does not match the gateway call.");
        }
        if (providerId !== expectedProviderId) {
          fail("LLM provider stream.start provider id does not match the selected provider.");
        }
        if (
          model.provider !== expectedModel.provider ||
          model.model !== expectedModel.model ||
          model.baseUrl !== expectedModel.baseUrl
        ) {
          fail("LLM provider stream.start model does not match the request model.");
        }
        streamState = "STARTED";
        return;
      }

      assertStarted();
      if (event.type === "stream.finish") {
        if (toolStatesHasOpenCall(toolStates)) {
          fail("LLM provider stream.finish cannot close an open tool call.");
        }
        streamState = "FINISHED";
        return;
      }

      if (event.type === "tool_call.start") {
        if (toolStates.has(event.payload.toolCallId)) {
          fail(`LLM provider emitted duplicate tool call start for "${event.payload.toolCallId}".`);
        }
        toolStates.set(event.payload.toolCallId, { state: "STARTED", name: event.payload.toolName });
        return;
      }

      if (event.type === "tool_call.delta") {
        const lifecycle = toolStates.get(event.payload.toolCallId);
        if (lifecycle === undefined || lifecycle.state !== "STARTED") {
          fail(`LLM provider emitted tool call delta for inactive call "${event.payload.toolCallId}".`);
        }
        return;
      }

      if (event.type === "tool_call.completed") {
        const lifecycle = toolStates.get(event.payload.id);
        if (lifecycle === undefined) {
          fail(`LLM provider completed inactive tool call "${event.payload.id}".`);
          return;
        }
        if (lifecycle.state !== "STARTED") {
          fail(`LLM provider completed inactive tool call "${event.payload.id}".`);
        }
        if (lifecycle.name !== event.payload.name) {
          fail(`LLM provider tool call "${event.payload.id}" changed tool name.`);
        }
        lifecycle.state = "COMPLETED";
      }
    },

    assertFinished(): void {
      if (streamState !== "FINISHED") {
        fail("LLM provider stream ended without stream.finish.");
      }
    },
  };
}

function toolStatesHasOpenCall(toolStates: Map<string, ToolLifecycle>): boolean {
  for (const lifecycle of toolStates.values()) {
    if (lifecycle.state === "STARTED") return true;
  }
  return false;
}
