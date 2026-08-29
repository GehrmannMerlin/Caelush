import {
  RuntimeError,
  RuntimeInvariantError,
  type RuntimeResolver,
  type RuntimeWorkspaceScope,
} from "@caelush/runtime";
import type { JsonObject } from "@caelush/protocol";
import type { ToolExecutionRequest } from "../handler.js";
import type { ToolExecutionResult } from "../execution-result.js";

export const READ_FILE_DEFAULT_LIMIT = 400;
export const READ_FILE_MAX_LIMIT = 2000;
export const LIST_DIRECTORY_DEFAULT_LIMIT = 200;
export const LIST_DIRECTORY_MAX_LIMIT = 500;
export const FIND_FILES_DEFAULT_LIMIT = 100;
export const FIND_FILES_MAX_LIMIT = 500;
export const SEARCH_TEXT_DEFAULT_LIMIT = 100;
export const SEARCH_TEXT_MAX_LIMIT = 200;
export const MAX_FIND_PATTERN_BYTES = 2048;
export const MAX_SEARCH_MATCH_CHARS = 1000;

export const READ_ONLY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    path: { type: "string" },
    pattern: { type: "string" },
    offset: { type: "integer" },
    count: { type: "integer" },
    linesReturned: { type: "integer" },
    bytesReturned: { type: "integer" },
    truncated: { type: "boolean" },
    nextOffset: { type: "integer" },
    utf8Bom: { type: "boolean" },
    files: { type: "array", items: { type: "string" } },
    entries: { type: "array", items: { type: "object" } },
    matches: { type: "array", items: { type: "object" } },
  },
  required: ["ok"],
  additionalProperties: false,
};

export function errorResult(code: string, message: string): ToolExecutionResult {
  return { content: message, details: { ok: false, error: code }, isError: true };
}

export function successResult(content: string, details: JsonObject): ToolExecutionResult {
  return { content, details: { ok: true, ...details }, isError: false };
}

export async function withRuntimeScope(
  request: ToolExecutionRequest,
  resolver: RuntimeResolver,
  operation: (scope: RuntimeWorkspaceScope) => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  const runtime = resolver.resolve(request.environment.runtime);
  if (runtime === undefined)
    return errorResult("UNSUPPORTED_RUNTIME", "The requested runtime is unavailable.");
  try {
    return await operation(await runtime.openWorkspace(request.environment.workspace));
  } catch (error) {
    if (error instanceof RuntimeInvariantError) throw error;
    if (error instanceof RuntimeError) return errorResult(error.code, safeRuntimeMessage(error));
    throw error;
  }
}

export function positiveBoundedInteger(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < 1 ||
    result > maximum
  ) {
    throw new Error("INVALID_RANGE");
  }
  return result;
}

export function safeRuntimeMessage(error: RuntimeError): string {
  return `Tool operation failed: ${error.code}.`;
}
