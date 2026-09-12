import { createAIError } from "../errors/ai-error.js";
import type { AIError, AIErrorContext } from "../errors/ai-error.js";

interface ToolCallLifecycle {
  name: string;
  completed: boolean;
}

/**
 * The tool-call lifecycle rules shared by the public stream and the adapter
 * boundary.
 *
 * Both sides must apply exactly the same rules — an adapter that merges two tool
 * ids and a gateway that accepts it are the same defect — so the rules live here
 * once and both callers use this tracker.
 */
export interface ToolCallTracker {
  /** Announce a tool call. A duplicate id is a stream violation. */
  start(toolCallId: string, toolName: string, context: AIErrorContext): void;
  /** Record argument text. A delta for an inactive call is a violation. */
  delta(toolCallId: string, context: AIErrorContext): void;
  /** Complete a tool call. An inactive call or a renamed tool is a violation. */
  complete(toolCallId: string, toolName: string, context: AIErrorContext): void;
  /** Ids announced but not completed, in announcement order. */
  openIds(): readonly string[];
  /** Every id seen, in announcement order. */
  knownIds(): readonly string[];
}

/** Create a tool-call tracker. */
export function createToolCallTracker(): ToolCallTracker {
  const lifecycles = new Map<string, ToolCallLifecycle>();

  const invalidResponse = (message: string, context: AIErrorContext): AIError =>
    createAIError("AI_INVALID_RESPONSE", message, context);

  return {
    start(toolCallId, toolName, context): void {
      if (lifecycles.has(toolCallId)) {
        throw invalidResponse(
          `AI stream announced the tool call "${toolCallId}" more than once.`,
          context,
        );
      }
      lifecycles.set(toolCallId, { name: toolName, completed: false });
    },

    delta(toolCallId, context): void {
      const lifecycle = lifecycles.get(toolCallId);
      if (lifecycle === undefined || lifecycle.completed) {
        throw invalidResponse(
          `AI stream emitted a delta for the inactive tool call "${toolCallId}".`,
          context,
        );
      }
    },

    complete(toolCallId, toolName, context): void {
      const lifecycle = lifecycles.get(toolCallId);
      if (lifecycle === undefined || lifecycle.completed) {
        throw invalidResponse(
          `AI stream completed the inactive tool call "${toolCallId}".`,
          context,
        );
      }
      if (lifecycle.name !== toolName) {
        throw invalidResponse(`AI stream changed the tool name of "${toolCallId}".`, context);
      }
      lifecycle.completed = true;
    },

    openIds(): readonly string[] {
      return [...lifecycles.entries()]
        .filter(([, lifecycle]) => !lifecycle.completed)
        .map(([toolCallId]) => toolCallId);
    },

    knownIds(): readonly string[] {
      return [...lifecycles.keys()];
    },
  };
}
