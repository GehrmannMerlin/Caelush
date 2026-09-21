import { RuntimeInvalidPatternError, RuntimeInvariantError } from "@caelush/runtime";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { CodingReadOnlyOperations } from "../operations/coding-read-only-operations.js";
import { projectFindFilesSecurityFacts } from "../security/security-facts.js";
import { FIND_FILES_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { defineCodingTool } from "./define-coding-tool.js";
import {
  errorResult,
  FIND_FILES_DEFAULT_LIMIT,
  FIND_FILES_MAX_LIMIT,
  MAX_FIND_PATTERN_BYTES,
  positiveBoundedInteger,
  READ_ONLY_OUTPUT_SCHEMA,
  runtimeErrorToResult,
  successResult,
  asOverlaySecurityFactsProjector,
  type AgentToolResult,
} from "./result.js";

/**
 * `find_files` — discover workspace files by glob.
 *
 * ## Pattern validation stays in the Tool
 *
 * A glob is validated before it reaches the port: non-empty, bounded to 2048 bytes, not absolute, and
 * free of `..` traversal. Those are the Tool's own business rules about what it will ask for, and the
 * Operation is not asked to repeat them — a second validator would be a second authority over the same
 * question.
 *
 * ## Behaviour is unchanged
 *
 * Same name, description, input schema, defaults, bounds, details shape and failure codes.
 */
const inputSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", minLength: 1, description: "Glob pattern for file discovery." },
    path: {
      type: "string",
      minLength: 1,
      default: ".",
      description: "Workspace-relative search directory; defaults to the workspace root '.'.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: FIND_FILES_MAX_LIMIT,
      default: FIND_FILES_DEFAULT_LIMIT,
      description: `Maximum number of returned files; defaults to ${FIND_FILES_DEFAULT_LIMIT}.`,
    },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

function validatePattern(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_FIND_PATTERN_BYTES
  ) {
    throw new RuntimeInvalidPatternError("glob pattern is invalid");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new RuntimeInvalidPatternError("glob pattern must remain inside the workspace");
  }
  return normalized;
}

export function createFindFilesTool(
  operations: Pick<CodingReadOnlyOperations, "find" | "findWithRoot">,
): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "find_files",
    description: "Find workspace files.",
    inputSchema,
    resultDetailsSchema: READ_ONLY_OUTPUT_SCHEMA,
    execute: async (input): Promise<AgentToolResult> => {
      const args = input.args as { pattern?: unknown; path?: unknown; limit?: unknown };
      let pattern: string;
      let limit: number;
      try {
        pattern = validatePattern(args.pattern);
        limit = positiveBoundedInteger(args.limit, FIND_FILES_DEFAULT_LIMIT, FIND_FILES_MAX_LIMIT);
      } catch (error) {
        const code =
          error instanceof RuntimeInvalidPatternError ? "INVALID_PATTERN" : "INVALID_RANGE";
        return errorResult(code, `Tool operation failed: ${code}.`);
      }
      const searchPath = args.path === undefined ? "." : args.path;
      if (typeof searchPath !== "string") {
        return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
      }

      try {
        const found = await operations.findWithRoot({
          environment: input.environment,
          pattern,
          path: searchPath,
          limit,
          signal: input.signal,
        });
        return successResult(
          found.files.length === 0 ? "No files found." : found.files.join("\n"),
          {
            path: found.path,
            pattern,
            count: found.files.length,
            truncated: found.truncated,
            files: found.files,
          },
        );
      } catch (error) {
        if (error instanceof RuntimeInvariantError) throw error;
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
      runtimeRequirements: { runtimeKinds: ["local"] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectFindFilesSecurityFacts),
    promptSnippet: FIND_FILES_PROMPT_SNIPPET,
  };
}

export { inputSchema as findFilesInputSchema };
