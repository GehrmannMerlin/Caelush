import type { JsonObject } from "@caelush/ai";
import type { ToolInvocation, ToolName } from "@caelush/protocol";

import type { AgentToolResult } from "../types/tool-result.js";

/**
 * The result sanitization boundary.
 *
 * ```ts
 * export interface ToolResultSanitizerPort {
 *   sanitize(input: {
 *     readonly toolName: ToolName;
 *     readonly result: AgentToolResult;
 *     readonly invocation: ToolInvocation;
 *   }): AgentToolResult;
 * }
 * ```
 *
 * ```text
 * agent defines the port
 * @caelush/security implements it
 * ```
 *
 * The direction is one-way and has no exception: `@caelush/agent` never imports a redaction
 * implementation, and every production Tool result passes through this port before it can become a
 * durable observation.
 *
 * ## Failure is settlement-blocking
 *
 * A throw here is a `RESULT_PIPELINE` infrastructure failure, never an `isError: true` result. The
 * difference from the transient update sanitizer is the point: an update that cannot be sanitized is
 * dropped and the Tool carries on, because nothing durable depends on it; a *final result* that
 * cannot be sanitized leaves no defensible durable record, and pretending the Tool merely failed
 * would invite a retry on top of an unredacted side effect.
 */
export interface ToolResultSanitizerPort {
  sanitize(input: {
    readonly toolName: ToolName;
    readonly result: AgentToolResult;
    readonly invocation: ToolInvocation;
  }): AgentToolResult;
}

/** The sanitizer that changes nothing, for a host with no redaction implementation configured. */
export const IDENTITY_TOOL_RESULT_SANITIZER: ToolResultSanitizerPort = Object.freeze({
  sanitize(input: {
    readonly toolName: ToolName;
    readonly result: AgentToolResult;
    readonly invocation: ToolInvocation;
  }): AgentToolResult {
    void input.toolName;
    void input.invocation;
    return input.result;
  },
});

/**
 * Which obligation a raw or sanitized result failed.
 *
 * ```text
 * SHAPE           not exactly { content: string, details: JsonObject, isError: boolean }
 * DETAILS_BUDGET  details exceeded their byte budget
 * DETAILS_SCHEMA  details failed the Tool's registered resultDetailsSchema
 * ```
 *
 * The kinds exist so the durable shell can keep telling a **result contract violation** apart from a
 * **pipeline infrastructure failure**: the first is settled as a fatal Tool output error, the second
 * is not, and merging them would change what a restart finds.
 */
export type ToolResultValidationErrorKind = "SHAPE" | "DETAILS_BUDGET" | "DETAILS_SCHEMA";

/**
 * The raw or sanitized result did not satisfy the registered result contract.
 *
 * This is a *typed cause*, not a model-facing failure: the caller decides how to settle it. Its
 * message never contains the offending value.
 */
export class ToolResultValidationError extends Error {
  readonly kind: ToolResultValidationErrorKind;

  constructor(kind: ToolResultValidationErrorKind, message?: string) {
    super(message ?? defaultValidationMessage(kind));
    this.name = "ToolResultValidationError";
    this.kind = kind;
  }
}

function defaultValidationMessage(kind: ToolResultValidationErrorKind): string {
  switch (kind) {
    case "SHAPE":
      return "Tool execution result does not have the exact { content, details, isError } shape.";
    case "DETAILS_BUDGET":
      return "Tool execution result details exceed their byte budget.";
    case "DETAILS_SCHEMA":
      return "Tool execution result details failed the registered output schema.";
  }
}

/**
 * The validated result a settlement may commit.
 *
 * `details` is a frozen JSON object, and the whole value is frozen. The `JsonObject` here is the AI
 * package's local JSON model, which is what an `AgentTool` speaks.
 */
export interface ValidatedToolResult {
  readonly content: string;
  readonly details: JsonObject;
  readonly isError: boolean;
}
