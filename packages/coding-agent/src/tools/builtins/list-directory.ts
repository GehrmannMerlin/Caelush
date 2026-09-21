import { RuntimeInvariantError } from "@caelush/runtime";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { CodingReadOnlyOperations } from "../operations/coding-read-only-operations.js";
import { projectListDirectorySecurityFacts } from "../security/security-facts.js";
import { LIST_DIRECTORY_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { defineCodingTool } from "./define-coding-tool.js";
import {
  errorResult,
  LIST_DIRECTORY_DEFAULT_LIMIT,
  LIST_DIRECTORY_MAX_LIMIT,
  positiveBoundedInteger,
  READ_ONLY_OUTPUT_SCHEMA,
  runtimeErrorToResult,
  successResult,
  asOverlaySecurityFactsProjector,
  type AgentToolResult,
} from "./result.js";

/**
 * `list_directory` — list one workspace directory's children.
 *
 * ## The `offset` reconciliation
 *
 * The Tool has an `offset`; the frozen `ListDirectoryOperations.list` does not. That is not a gap to be
 * papered over with a widened interface — a directory listing is a bounded, ordered, cheaply
 * re-derivable set, so this Tool asks the port for the window it needs and slices it itself:
 *
 * ```text
 * entries needed        = offset - 1 + limit
 * operations.list({ limit: offset - 1 + limit })
 * visible entries       = entries.slice(offset - 1)
 * truncated             = (offset - 1 + visible) < total the port reported it could see
 * ```
 *
 * The port is asked for `offset - 1 + limit` entries, which is exactly the prefix the Tool is allowed
 * to look at. A `truncated: true` from the port means the directory holds more than that prefix, so
 * anything at or beyond it is genuinely omitted. The visible entries, their order, the `nextOffset` the
 * Tool reports, the bounds and the truncation flag are therefore all functions of the same sorted list
 * the legacy Tool saw — the migration changes who performs the slice, not what the model receives.
 *
 * ## Behaviour is unchanged
 *
 * Same name, description, input schema, defaults, bounds, details shape and failure codes.
 */
const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Workspace-relative directory path; use '.' for the workspace root.",
    },
    offset: {
      type: "integer",
      minimum: 1,
      default: 1,
      description: "1-indexed first entry to return; defaults to 1.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: LIST_DIRECTORY_MAX_LIMIT,
      default: LIST_DIRECTORY_DEFAULT_LIMIT,
      description: `Maximum number of returned entries; defaults to ${LIST_DIRECTORY_DEFAULT_LIMIT}.`,
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

export function createListDirectoryTool(
  operations: Pick<CodingReadOnlyOperations, "list" | "listWithProbe">,
): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "list_directory",
    description: "List dir.",
    inputSchema,
    resultDetailsSchema: READ_ONLY_OUTPUT_SCHEMA,
    execute: async (input): Promise<AgentToolResult> => {
      const args = input.args as { path?: unknown; offset?: unknown; limit?: unknown };
      if (typeof args.path !== "string") {
        return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
      }
      let offset: number;
      let limit: number;
      try {
        offset = positiveBoundedInteger(args.offset, 1, Number.MAX_SAFE_INTEGER);
        limit = positiveBoundedInteger(
          args.limit,
          LIST_DIRECTORY_DEFAULT_LIMIT,
          LIST_DIRECTORY_MAX_LIMIT,
        );
      } catch {
        return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
      }

      try {
        // Ask for the prefix this request may reveal, plus one entry. The extra entry is what makes
        // `truncated` and `nextOffset` decidable from the returned list alone: receiving `limit + 1`
        // entries after the offset proves something follows, and receiving fewer proves the end.
        const listed = await operations.listWithProbe({
          environment: input.environment,
          path: args.path,
          limit: offset - 1 + limit + 1,
          signal: input.signal,
        });
        const window = listed.entries.slice(offset - 1);
        const items = window.slice(0, limit);
        const lines = items.map((entry) => {
          const name = typeof entry.name === "string" ? entry.name : "";
          const kind = entry.kind;
          return `${name}${kind === "DIRECTORY" ? "/" : kind === "SYMLINK" ? "@" : ""}`;
        });
        const truncated = window.length > limit;
        return successResult(lines.length === 0 ? "(empty directory)" : lines.join("\n"), {
          path: listed.path,
          offset,
          count: items.length,
          truncated,
          entries: items,
          ...(truncated ? { nextOffset: offset + items.length } : {}),
        });
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
    securityFactsProjector: asOverlaySecurityFactsProjector(projectListDirectorySecurityFacts),
    promptSnippet: LIST_DIRECTORY_PROMPT_SNIPPET,
  };
}

export { inputSchema as listDirectoryInputSchema };
