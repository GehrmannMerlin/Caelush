import {
  JsonObjectSchema,
  type JsonObject,
  type JsonValue,
  type ToolName,
} from "@caelush/protocol";
import {
  canonicalJsonString,
  cloneJsonValue,
  deepFreezeJson,
  jsonUtf8ByteLength,
} from "./json-canonical.js";
import type { ResolvedTool } from "./registry.js";
import type { ToolSchemaIssue } from "./schema-runtime.js";

export type NormalizedArguments = Readonly<JsonObject>;

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

/**
 * Normalizes only values whose target JSON Schema explicitly declares a number
 * type, then applies the already-compiled strict validator. No defaults,
 * unknown-property removal, or text rewriting are performed.
 */
export function validateToolArguments(
  tool: Pick<ResolvedTool, "definition" | "inputValidator">,
  value: unknown,
  options: { readonly maxBytes?: number } = {},
): NormalizedArguments {
  const parsed = JsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new ToolValidationError(tool.definition.name, [
      { instancePath: "", keyword: "type", message: "must be an object" },
    ]);
  }

  const cloned = cloneJsonValue(parsed.data) as JsonObject;
  const normalized = normalizeValue(cloned, tool.definition.inputSchema) as JsonObject;
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
  return deepFreezeJson(normalized) as NormalizedArguments;
}

function normalizeValue(value: JsonValue, schema: JsonObject): JsonValue {
  if (typeof value === "string" && (schema.type === "integer" || schema.type === "number")) {
    const converted = parseNumericString(value);
    if (
      converted !== undefined &&
      (schema.type !== "integer" || Number.isSafeInteger(converted))
    ) {
      return converted;
    }
  }

  if (Array.isArray(value)) {
    const itemSchema = asJsonObject(schema.items);
    if (itemSchema !== undefined) {
      return value.map((item) => normalizeValue(item, itemSchema));
    }
    return value;
  }

  if (isJsonObject(value)) {
    const properties = asJsonObject(schema.properties);
    if (properties === undefined) return value;
    for (const [key, child] of Object.entries(value)) {
      const childSchema = asJsonObject(properties[key]);
      if (childSchema !== undefined) value[key] = normalizeValue(child, childSchema);
    }
  }
  return value;
}

function parseNumericString(value: string): number | undefined {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatValidationMessage(toolName: ToolName, issues: readonly ToolSchemaIssue[]): string {
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
