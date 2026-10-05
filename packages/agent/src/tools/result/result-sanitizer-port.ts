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
 *   }): ToolResultSanitizationOutcome;
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
 * ## Refusal is all-or-nothing
 *
 * The Security implementation returns `REFUSED` without a result when it cannot prove complete
 * sanitization. The Result Pipeline converts that ordinary output failure into bounded model
 * feedback; it never substitutes the raw value or a partially scanned object. Thrown sanitizer
 * failures follow the same safe output-failure path.
 */
export type ToolResultSanitizationRefusalReason =
  "SCAN_NODE_LIMIT" | "SCAN_DEPTH_LIMIT" | "TEXT_LIMIT";

export type ToolResultSanitizationOutcome =
  | { readonly kind: "SANITIZED"; readonly result: AgentToolResult }
  | { readonly kind: "REFUSED"; readonly reason: ToolResultSanitizationRefusalReason };

export interface ToolResultSanitizerPort {
  sanitize(input: {
    readonly toolName: ToolName;
    readonly result: AgentToolResult;
    readonly invocation: ToolInvocation;
  }): ToolResultSanitizationOutcome;
}

/** The sanitizer that changes nothing, for a host with no redaction implementation configured. */
export const IDENTITY_TOOL_RESULT_SANITIZER: ToolResultSanitizerPort = Object.freeze({
  sanitize(input: {
    readonly toolName: ToolName;
    readonly result: AgentToolResult;
    readonly invocation: ToolInvocation;
  }): ToolResultSanitizationOutcome {
    void input.toolName;
    void input.invocation;
    return { kind: "SANITIZED", result: input.result };
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
 * The kinds let the Result Pipeline materialize expected result contract violations as bounded
 * `TOOL_OUTPUT_ERROR` values while leaving unexpected implementation failures as infrastructure
 * defects.
 */
export type ToolResultValidationErrorKind = "SHAPE" | "DETAILS_BUDGET" | "DETAILS_SCHEMA";

/**
 * The raw or sanitized result did not satisfy the registered result contract.
 *
 * This is a *typed local cause*, not a model-facing failure. Its message never contains the offending
 * value; the Result Pipeline maps it to generic safe output feedback.
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
