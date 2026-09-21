import {
  RuntimeInvariantError,
  RuntimeSearchError,
  RuntimeSearchUnavailableError,
} from "@caelush/runtime";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { CodingReadOnlyOperations } from "../operations/coding-read-only-operations.js";
import { projectSearchTextSecurityFacts } from "../security/security-facts.js";
import { SEARCH_TEXT_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { defineCodingTool } from "./define-coding-tool.js";
import {
  errorResult,
  MAX_SEARCH_GLOB_BYTES,
  MAX_SEARCH_MATCH_CHARS,
  positiveBoundedInteger,
  READ_ONLY_OUTPUT_SCHEMA,
  runtimeErrorToResult,
  SEARCH_TEXT_DEFAULT_LIMIT,
  SEARCH_TEXT_MAX_LIMIT,
  successResult,
  asOverlaySecurityFactsProjector,
  type AgentToolResult,
} from "./result.js";

/**
 * `search_text` — search workspace text.
 *
 * ## The reconciliation this Tool needed
 *
 * `include` and `limit` are Tool-visible arguments, and the original frozen `SearchTextOperations`
 * carried neither. Post-filtering could not be equivalent, because `include` is a ripgrep `--glob`
 * applied *before* truncation: filtering an already-truncated list changes which matches exist.
 *
 * `docs/architecture/v2/PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md` corrected the port to carry
 * `include` and `limit`, which lets this Tool keep its behaviour exactly as it was:
 *
 * ```text
 * include  →  the port  →  ripgrep --glob, a path-level pre-filter
 * limit    →  the port  →  the business-visible maximum
 * ```
 *
 * The adapter asks the Runtime for `limit + 1` matches, so "there were more" is provable from the
 * returned set rather than guessed — the same `N + 1` probe the legacy Tool used.
 *
 * ## Behaviour is unchanged
 *
 * Same name, description, input schema, defaults, bounds, details shape and failure codes. `include` is
 * normalised (backslashes to forward slashes, bounded, no absolute path, no `..`) before it is passed,
 * and the Tool still verifies that every returned match resolves to a real file inside the search root.
 */
const inputSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      minLength: 1,
      description: "Ripgrep-compatible regular expression.",
    },
    path: {
      type: "string",
      minLength: 1,
      default: ".",
      description: "Workspace-relative search directory; defaults to the workspace root '.'.",
    },
    include: { type: "string", minLength: 1, description: "Optional file glob to include." },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: SEARCH_TEXT_MAX_LIMIT,
      default: SEARCH_TEXT_DEFAULT_LIMIT,
      description: `Maximum number of returned matches; defaults to ${SEARCH_TEXT_DEFAULT_LIMIT}.`,
    },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

/** Bound one match's text so a single very long line cannot dominate the result. */
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

export function createSearchTextTool(
  operations: Pick<CodingReadOnlyOperations, "search" | "searchWithRoot">,
): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "search_text",
    description: "Search workspace text.",
    inputSchema,
    resultDetailsSchema: READ_ONLY_OUTPUT_SCHEMA,
    execute: async (input): Promise<AgentToolResult> => {
      const args = input.args as {
        pattern?: unknown;
        path?: unknown;
        include?: unknown;
        limit?: unknown;
      };
      if (typeof args.pattern !== "string" || args.pattern.length === 0) {
        return errorResult("INVALID_PATTERN", "Tool operation failed: INVALID_PATTERN.");
      }
      let include: string | undefined;
      try {
        include = validateInclude(args.include);
      } catch {
        return errorResult("INVALID_PATTERN", "Tool operation failed: INVALID_PATTERN.");
      }
      let limit: number;
      try {
        limit = positiveBoundedInteger(
          args.limit,
          SEARCH_TEXT_DEFAULT_LIMIT,
          SEARCH_TEXT_MAX_LIMIT,
        );
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

      try {
        const result = await operations.search({
          environment: input.environment,
          pattern: args.pattern,
          path: searchPath,
          ...(include === undefined ? {} : { include }),
          limit,
          signal: input.signal,
        });
        const matches = result.matches.map((match) => ({
          path: typeof match.path === "string" ? match.path : "",
          line: typeof match.line === "number" ? match.line : 0,
          text: boundedMatchText(typeof match.text === "string" ? match.text : ""),
        }));
        const content =
          matches.length === 0
            ? "No matches found."
            : matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n");
        return successResult(content, {
          path: searchPath === "." ? "." : searchPath,
          pattern: args.pattern,
          count: matches.length,
          truncated: result.truncated,
          matches,
        });
      } catch (error) {
        if (error instanceof RuntimeInvariantError) throw error;
        if (error instanceof RuntimeSearchUnavailableError) {
          return errorResult("RIPGREP_UNAVAILABLE", "Tool operation failed: RIPGREP_UNAVAILABLE.");
        }
        if (error instanceof RuntimeSearchError) {
          return errorResult("INVALID_PATTERN", "Tool operation failed: INVALID_PATTERN.");
        }
        const mapped = runtimeErrorToResult(error);
        if (mapped !== undefined) return mapped;
        throw error;
      }
    },
  });

  return {
    tool,
    security: {
      riskLevel: "LOW",
      requiredCapabilities: ["FS_READ"],
      runtimeRequirements: { runtimeKinds: ["local"], executables: ["rg"] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectSearchTextSecurityFacts),
    promptSnippet: SEARCH_TEXT_PROMPT_SNIPPET,
  };
}

export { inputSchema as searchTextInputSchema };
