import type { JsonObject } from "@caelush/ai";

import {
  canonicalJsonString,
  cloneJsonValue,
  deepFreezeJson,
  jsonUtf8ByteLength,
} from "../schema/json-canonical.js";
import type { ResolvedAgentTool } from "../registry/registry.js";
import type { AgentToolResult } from "../types/tool-result.js";
import { ToolResultValidationError, type ValidatedToolResult } from "./result-sanitizer-port.js";
import { boundToolResultContent, type ToolResultLimits } from "./result-policy.js";

/**
 * The canonical Tool result validation.
 *
 * ```text
 * exact shape      content: string, details: JsonObject, isError: boolean — and nothing else
 * details budget   canonically serialized UTF-8 bytes, within maxDetailsBytes
 * result schema    the Tool's own compiled resultValidator
 * copy             null-prototype clone, deeply frozen
 * bound            content bounded to maxDurableContentBytes at a whole-character boundary
 * ```
 *
 * ## Why the runtime check is not redundant with the TypeScript type
 *
 * `execute(): Promise<AgentToolResult>` is a declaration, and a Tool is an untrusted execution
 * boundary: it can return a class instance, a promise, an extra property or a number where a string
 * was declared, and TypeScript will never see it. A missing, extra or mistyped field is a contract
 * violation that must fail the settlement rather than reach a durable row.
 *
 * ## Why no schema is compiled here
 *
 * `resolvedTool.resultValidator` was compiled once at registry build time. This layer never creates a
 * compiler, never recompiles a schema and never maintains a second schema algorithm: it *calls* the
 * validator the canonical registry already produced.
 */
export function validateToolResult(input: {
  readonly value: unknown;
  readonly resolved: ResolvedAgentTool;
  readonly limits: ToolResultLimits;
}): ValidatedToolResult {
  const shape = readResultShape(input.value);
  assertDetailsBudget(shape.details, input.limits);

  const validation = input.resolved.resultValidator.validate(shape.details);
  if (!validation.valid) {
    throw new ToolResultValidationError("DETAILS_SCHEMA");
  }

  return Object.freeze({
    content: boundToolResultContent(shape.content, input.limits),
    details: deepFreezeJson(cloneJsonValue(shape.details)),
    isError: shape.isError,
  });
}

function assertDetailsBudget(details: JsonObject, limits: ToolResultLimits): void {
  if (jsonUtf8ByteLength(canonicalJsonString(details)) > limits.maxDetailsBytes) {
    throw new ToolResultValidationError("DETAILS_BUDGET");
  }
}

interface ResultShape {
  readonly content: string;
  readonly details: JsonObject;
  readonly isError: boolean;
}

/**
 * Read a raw Tool result into its exact shape, or refuse it.
 *
 * ```text
 * a plain object with exactly content, details and isError
 * content  a string
 * isError  a boolean
 * details  a JSON object — not null, not an array, not a thenable, not a class instance
 * ```
 *
 * The prototype check is deliberate. An arbitrary class instance can carry behaviour and accessors
 * this layer cannot see, and a durable JSON column must never receive one.
 */
export function readResultShape(value: unknown): ResultShape {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolResultValidationError("SHAPE");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ToolResultValidationError("SHAPE");
  }
  const candidate = value as {
    readonly content?: unknown;
    readonly details?: unknown;
    readonly isError?: unknown;
  };
  if (Object.keys(value).length !== 3) throw new ToolResultValidationError("SHAPE");
  if (
    !Object.hasOwn(value, "content") ||
    !Object.hasOwn(value, "details") ||
    !Object.hasOwn(value, "isError")
  ) {
    throw new ToolResultValidationError("SHAPE");
  }
  if (typeof candidate.content !== "string" || typeof candidate.isError !== "boolean") {
    throw new ToolResultValidationError("SHAPE");
  }
  if (!isJsonObjectValue(candidate.details)) {
    throw new ToolResultValidationError("SHAPE");
  }
  return {
    content: candidate.content,
    details: candidate.details,
    isError: candidate.isError,
  };
}

function isJsonObjectValue(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { readonly then?: unknown }).then !== "function"
  );
}

/**
 * Re-shape a sanitized value into the result contract, or refuse it.
 *
 * Identical rules to `readResultShape`; a separate entry point exists so the pipeline's second pass
 * is explicit rather than incidental.
 */
export function readSanitizedResultShape(value: unknown): ResultShape {
  try {
    return readResultShape(value);
  } catch (error) {
    if (error instanceof ToolResultValidationError) {
      throw new ToolResultValidationError("SHAPE", "Sanitized Tool result is invalid.");
    }
    throw error;
  }
}

/** True when a value already has the result contract shape. */
export function isAgentToolResult(value: unknown): value is AgentToolResult {
  try {
    readResultShape(value);
    return true;
  } catch {
    return false;
  }
}
