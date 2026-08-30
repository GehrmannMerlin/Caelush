import type { ToolDefinition } from "@caelush/protocol";
import {
  RuntimeInvariantError,
  RuntimeSearchError,
  RuntimeSearchUnavailableError,
  type RuntimeResolver,
} from "@caelush/runtime";
import type { ToolExecutionRequest, ToolHandler } from "../handler.js";
import type { ToolRegistration } from "../registration.js";
import {
  MAX_SEARCH_MATCH_CHARS,
  READ_ONLY_OUTPUT_SCHEMA,
  SEARCH_TEXT_DEFAULT_LIMIT,
  SEARCH_TEXT_MAX_LIMIT,
  errorResult,
  positiveBoundedInteger,
  successResult,
  withRuntimeScope,
} from "./result.js";
import { projectSearchTextSecurityFacts } from "./security-facts.js";

const definition: ToolDefinition = {
  name: "search_text",
  description: "Searches workspace text with a ripgrep-compatible regular expression.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        description: "Ripgrep-compatible regular expression.",
      },
      path: { type: "string", minLength: 1, description: "Workspace-relative search directory." },
      include: { type: "string", minLength: 1, description: "Optional file glob to include." },
      limit: { type: "integer", minimum: 1, description: "Maximum number of returned matches." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  outputSchema: READ_ONLY_OUTPUT_SCHEMA,
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { runtimeKinds: ["local"], executables: ["rg"] },
};

const MAX_SEARCH_GLOB_BYTES = 2048;

export function createSearchTextRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const handler: ToolHandler = {
    execute: async (request) => executeSearchText(request, runtimeResolver),
  };
  return { definition, handler, securityFactsProjector: projectSearchTextSecurityFacts };
}

function boundedMatchText(text: string): string {
  const characters = Array.from(text);
  return characters.length > MAX_SEARCH_MATCH_CHARS
    ? `${characters.slice(0, MAX_SEARCH_MATCH_CHARS).join("")}... [match truncated]`
    : text;
}

function validateInclude(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SEARCH_GLOB_BYTES
  ) {
    throw new Error("INVALID_PATTERN");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("INVALID_PATTERN");
  }
  return normalized;
}

async function executeSearchText(request: ToolExecutionRequest, resolver: RuntimeResolver) {
  const args = request.args as {
    pattern?: unknown;
    path?: unknown;
    include?: unknown;
    limit?: unknown;
  };
  if (typeof args.pattern !== "string" || args.pattern.length === 0)
    return errorResult("INVALID_PATTERN", "Tool operation failed: INVALID_PATTERN.");
  let include: string | undefined;
  try {
    include = validateInclude(args.include);
  } catch {
    return errorResult("INVALID_PATTERN", "Tool operation failed: INVALID_PATTERN.");
  }
  let limit: number;
  try {
    limit = positiveBoundedInteger(args.limit, SEARCH_TEXT_DEFAULT_LIMIT, SEARCH_TEXT_MAX_LIMIT);
  } catch {
    return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
  }
  const searchPath = args.path === undefined ? "." : args.path;
  if (
    typeof searchPath !== "string" ||
    (args.include !== undefined && typeof args.include !== "string")
  ) {
    return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
  }
  return withRuntimeScope(request, resolver, async (scope) => {
    const resolved = await scope.pathResolver.resolveExisting(searchPath);
    if (resolved.kind !== "DIRECTORY")
      return errorResult("NOT_A_DIRECTORY", "Tool operation failed: NOT_A_DIRECTORY.");
    let result;
    try {
      result = await scope.textSearch.search({
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        cwd: resolved.absolutePath,
        pattern: args.pattern as string,
        ...(include === undefined ? {} : { include }),
        limit: limit + 1,
      });
    } catch (error) {
      if (error instanceof RuntimeInvariantError) throw error;
      if (error instanceof RuntimeSearchUnavailableError)
        return errorResult("RIPGREP_UNAVAILABLE", "Tool operation failed: RIPGREP_UNAVAILABLE.");
      if (error instanceof RuntimeSearchError)
        return errorResult("INVALID_PATTERN", "Tool operation failed: INVALID_PATTERN.");
      throw error;
    }
    const matches = [] as Array<{ path: string; line: number; text: string }>;
    for (const match of result.matches.slice(0, limit)) {
      if (
        match.path.startsWith("/") ||
        /^[A-Za-z]:[\\/]/.test(match.path) ||
        match.path.split("/").includes("..")
      ) {
        throw new RuntimeInvariantError("ripgrep returned a path outside its search root");
      }
      const relative =
        resolved.relativePath === "." ? match.path : `${resolved.relativePath}/${match.path}`;
      const checked = await scope.pathResolver.resolveExisting(relative);
      if (checked.kind !== "FILE")
        throw new RuntimeInvariantError("ripgrep returned a non-file result");
      matches.push({
        path: checked.relativePath,
        line: match.line,
        text: boundedMatchText(match.text),
      });
    }
    const truncated = result.truncated || result.matches.length > limit;
    const content =
      matches.length === 0
        ? "No matches found."
        : matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n");
    return successResult(content, {
      path: resolved.relativePath,
      pattern: args.pattern as string,
      count: matches.length,
      truncated,
      matches,
    });
  });
}
