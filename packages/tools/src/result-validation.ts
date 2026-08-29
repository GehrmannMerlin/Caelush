import { JsonObjectSchema, type JsonObject } from "@caelush/protocol";
import {
  canonicalJsonString,
  cloneJsonValue,
  deepFreezeJson,
  jsonUtf8ByteLength,
} from "./json-canonical.js";
import {
  boundToolModelContent,
  DEFAULT_TOOL_OUTPUT_POLICY,
  validateToolOutputPolicy,
  type ToolOutputPolicy,
} from "./output-policy.js";
import type { ResolvedTool } from "./registry.js";

export class ToolExecutionResultValidationError extends Error {
  readonly kind: "SHAPE" | "OUTPUT_SCHEMA" | "DETAILS_BUDGET";

  constructor(kind: ToolExecutionResultValidationError["kind"], message: string) {
    super(message);
    this.name = "ToolExecutionResultValidationError";
    this.kind = kind;
  }
}

export interface ValidatedToolExecutionResult {
  readonly content: string;
  readonly details: JsonObject;
  readonly isError: boolean;
}

export function validateToolExecutionResult(
  value: unknown,
  resolvedTool: ResolvedTool,
  policy: ToolOutputPolicy = DEFAULT_TOOL_OUTPUT_POLICY,
): ValidatedToolExecutionResult {
  validateToolOutputPolicy(policy);
  if (!isPlainObject(value) || !hasExactKeys(value, ["content", "details", "isError"])) {
    throw new ToolExecutionResultValidationError("SHAPE", "Tool execution result is invalid.");
  }
  if (typeof value.content !== "string" || typeof value.isError !== "boolean") {
    throw new ToolExecutionResultValidationError("SHAPE", "Tool execution result is invalid.");
  }
  const details = JsonObjectSchema.safeParse(value.details);
  if (!details.success) {
    throw new ToolExecutionResultValidationError(
      "SHAPE",
      "Tool execution result details are invalid.",
    );
  }
  if (jsonUtf8ByteLength(canonicalJsonString(details.data)) > policy.maxDetailsBytes) {
    throw new ToolExecutionResultValidationError(
      "DETAILS_BUDGET",
      "Tool execution result details exceed their byte budget.",
    );
  }
  const outputValidation = resolvedTool.outputValidator.validate(details.data);
  if (!outputValidation.valid) {
    throw new ToolExecutionResultValidationError(
      "OUTPUT_SCHEMA",
      "Tool execution result details failed the output schema.",
    );
  }

  const frozenDetails = deepFreezeJson(cloneJsonValue(details.data)) as JsonObject;
  return Object.freeze({
    content: boundToolModelContent(value.content, policy),
    details: frozenDetails,
    isError: value.isError,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
