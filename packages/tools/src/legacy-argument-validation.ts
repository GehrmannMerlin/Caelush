import type { JsonObject, ToolName } from "@caelush/protocol";
import {
  canonicalJsonString,
  deepFreezeJson as canonicalDeepFreezeJson,
  jsonUtf8ByteLength,
  type CompiledToolSchema,
  type ToolSchemaIssue,
} from "@caelush/agent";
import { normalizeToolArgumentsForCompatibility } from "@caelush/coding-agent";

/** Normalized, frozen legacy arguments. */
export type NormalizedArguments = Readonly<JsonObject>;

/**
 * The legacy argument validation failure.
 *
 * The class identity, the fields and the message format are unchanged: existing callers catch it,
 * `instanceof` it and assert on its message text.
 */
export class ToolValidationError extends Error {
  readonly toolName: ToolName;
  readonly issues: readonly ToolSchemaIssue[];

  constructor(toolName: ToolName, issues: readonly ToolSchemaIssue[]) {
    super(formatValidationMessage(toolName, issues));
    this.name = "ToolValidationError";
    this.toolName = toolName;
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

/** The minimum a legacy caller must supply to have its arguments validated. */
export interface LegacyArgumentValidationTarget {
  readonly definition: { readonly name: ToolName; readonly inputSchema: JsonObject };
  readonly inputValidator: CompiledToolSchema;
}

/**
 * The legacy argument validation entry point.
 *
 * ```text
 * legacy target  ──▶  canonical numeric compatibility normalization   (@caelush/coding-agent)
 *                ──▶  canonical compiled validator                    (the registry's own compiler)
 * ```
 *
 * There is no second validation algorithm and no second AJV instance here: the compiler that built
 * the validator validates, and the one numeric-string normalization lives in the Coding product layer
 * where it belongs, because it is a compatibility affordance for legacy Tools and not a rule every
 * generic Agent Tool inherits.
 *
 * The byte bound is the one this signature has always applied — after normalization — and it is
 * measured with the canonical serialization.
 */
export function validateToolArguments(
  tool: LegacyArgumentValidationTarget,
  value: unknown,
  options: { readonly maxBytes?: number } = {},
): NormalizedArguments {
  if (!isJsonObject(value)) {
    throw new ToolValidationError(tool.definition.name, [
      { instancePath: "", keyword: "type", message: "must be an object" },
    ]);
  }

  const normalized = normalizeToolArgumentsForCompatibility(tool.definition, value);
  if (
    options.maxBytes !== undefined &&
    jsonUtf8ByteLength(canonicalJsonString(normalized)) > options.maxBytes
  ) {
    throw new ToolValidationError(tool.definition.name, [
      { instancePath: "", keyword: "maxBytes", message: "arguments exceed the byte limit" },
    ]);
  }

  const validation = tool.inputValidator.validate(normalized);
  if (!validation.valid) throw new ToolValidationError(tool.definition.name, validation.issues);
  return canonicalDeepFreezeJson(normalized) as NormalizedArguments;
}

/** Build the legacy error for a canonical preparation rejection. */
export function toLegacyToolValidationError(
  toolName: ToolName,
  issues: readonly ToolSchemaIssue[],
): ToolValidationError {
  return new ToolValidationError(toolName, issues);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The exact legacy failure message format. */
export function formatValidationMessage(
  toolName: ToolName,
  issues: readonly ToolSchemaIssue[],
): string {
  const formatted = issues.slice(0, 16).map(formatIssue).join("; ");
  return `Tool ${toolName} failed validation: ${formatted || "arguments do not match the input schema"}.`;
}

function formatIssue(issue: ToolSchemaIssue): string {
  if (issue.keyword === "required") {
    const property = issue.message.match(/['"]([^'"]+)['"]/)?.[1];
    if (property !== undefined) return `${property} must be provided`;
  }
  const path = issue.instancePath
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
  return path.length === 0 ? issue.message : `${path} ${issue.message}`;
}
