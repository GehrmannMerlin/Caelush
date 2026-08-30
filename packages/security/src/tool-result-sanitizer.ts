import type { JsonObject } from "@caelush/protocol";
import type {
  ToolExecutionResult,
  ToolResultSanitizerPort,
} from "@caelush/tools";
import { redactJson, redactText } from "./secret-redaction.js";
import { classifySensitivePath } from "./sensitive-path.js";

export class CaelushToolResultSanitizer implements ToolResultSanitizerPort {
  sanitize(input: {
    readonly toolName: import("@caelush/protocol").ToolName;
    readonly result: ToolExecutionResult;
    readonly invocation: import("@caelush/protocol").ToolInvocation;
  }): ToolExecutionResult {
    void input.toolName;
    void input.invocation;
    let content = redactText(input.result.content);
    let details = redactJson(input.result.details) as JsonObject;
    if (input.toolName === "search_text") {
      const search = sanitizeSearchResult(input.result.content, input.result.details, details);
      content = search.content;
      details = search.details;
    } else if (
      input.toolName === "git_diff" &&
      (isSensitivePath(input.invocation["args"].path) || containsSensitiveDiffPath(input.result.content))
    ) {
      content = "[SENSITIVE DIFF CONTENT REDACTED]";
    }
    return {
      content,
      details,
      isError: input.result.isError,
    };
  }
}

function isSensitivePath(value: unknown): boolean {
  return typeof value === "string" && classifySensitivePath(value) !== undefined;
}

function sanitizeSearchResult(
  content: string,
  rawDetails: JsonObject,
  redactedDetails: JsonObject,
): { readonly content: string; readonly details: JsonObject } {
  const rawMatches = rawDetails.matches;
  const safeMatches = redactedDetails.matches;
  if (!Array.isArray(rawMatches) || !Array.isArray(safeMatches)) {
    return { content, details: redactedDetails };
  }
  const nextMatches = safeMatches.map((safeMatch, index) => {
    const rawMatch = rawMatches[index];
    if (
      rawMatch !== null &&
      typeof rawMatch === "object" &&
      !Array.isArray(rawMatch) &&
      isSensitivePath(rawMatch.path)
    ) {
      return { ...(safeMatch as JsonObject), text: "[REDACTED:SENSITIVE_FILE_CONTENT]" };
    }
    return safeMatch;
  });
  let nextContent = content;
  for (const rawMatch of rawMatches) {
    if (rawMatch === null || typeof rawMatch !== "object" || Array.isArray(rawMatch)) continue;
    if (!isSensitivePath(rawMatch.path) || typeof rawMatch.path !== "string") continue;
    const line = typeof rawMatch.line === "number" ? rawMatch.line : undefined;
    if (line === undefined) continue;
    const prefix = `${rawMatch.path}:${line}:`;
    nextContent = nextContent
      .split(/\r?\n/)
      .map((entry) => (entry.startsWith(prefix) ? `${prefix} [REDACTED:SENSITIVE_FILE_CONTENT]` : entry))
      .join("\n");
  }
  return { content: nextContent, details: { ...redactedDetails, matches: nextMatches } };
}

function containsSensitiveDiffPath(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const match = /^(?:\+\+\+|---) [ab]\/(\S+)/.exec(line);
    return match !== null && isSensitivePath(match[1]);
  });
}

export function sanitizeToolResult(
  input: Parameters<ToolResultSanitizerPort["sanitize"]>[0],
): ToolExecutionResult {
  return new CaelushToolResultSanitizer().sanitize(input);
}
