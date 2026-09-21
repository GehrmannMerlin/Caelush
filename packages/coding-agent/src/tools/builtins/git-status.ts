import {
  GIT_STATUS_DEFAULT_LIMIT,
  GIT_STATUS_MAX_LIMIT,
  RuntimeInvariantError,
} from "@caelush/runtime";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { GitOperations } from "../operations/operations.js";
import { projectGitStatusSecurityFacts } from "../security/security-facts.js";
import { GIT_STATUS_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { defineCodingTool } from "./define-coding-tool.js";
import {
  errorResult,
  positiveBoundedInteger,
  runtimeErrorToResult,
  successResult,
  asOverlaySecurityFactsProjector,
  type AgentToolResult,
} from "./result.js";

/**
 * `git_status` — read Git status.
 *
 * ## The reconciliation this Tool needed
 *
 * `path` is a real Git pathspec that decides *which paths Git reports at all*, and `limit` drives status
 * parsing. The original frozen `GitOperations.status` carried neither, and neither can be reconstructed
 * after the invocation: Git's pathspec semantics include glob and `:(magic)` forms that no string filter
 * reproduces.
 *
 * `docs/architecture/v2/PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md` corrected `status` to take
 * `args`, symmetric with the `diff` arm that already did. This Tool passes a canonical
 * `{ path?, limit }` shape, the adapter forwards it to `RuntimeGitService`, and **Git itself** applies the
 * pathspec inside `git status -- <path>`.
 *
 * The Tool never interprets a pathspec: no `startsWith`, no glob matching, no prefix filtering. That is
 * the whole point of the correction — the behaviour must come from Git, not from an approximation of Git.
 *
 * ## `limit` above the Runtime default
 *
 * The Tool allows up to 1000 entries while the Runtime's own default is 200. The corrected port carries
 * `limit` through, so a request for 250 entries returns 250 rather than being silently pinned to 200.
 *
 * ## Behaviour is unchanged
 *
 * Same name, description, input schema, defaults, bounds, details shape and failure codes.
 */
const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, description: "Workspace-relative pathspec." },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: GIT_STATUS_MAX_LIMIT,
      default: GIT_STATUS_DEFAULT_LIMIT,
      description: `Maximum number of status entries; defaults to ${GIT_STATUS_DEFAULT_LIMIT}.`,
    },
  },
  additionalProperties: false,
} as const;

const resultDetailsSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    branch: { type: "string" },
    detached: { type: "boolean" },
    ahead: { type: "integer", minimum: 0 },
    behind: { type: "integer", minimum: 0 },
    clean: { type: "boolean" },
    entries: { type: "array", items: { type: "object" } },
    truncated: { type: "boolean" },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

export function createGitStatusTool(operations: GitOperations): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "git_status",
    description: "Git.",
    inputSchema,
    resultDetailsSchema,
    execute: async (input): Promise<AgentToolResult> => {
      const path = input.args.path;
      if (path !== undefined && typeof path !== "string") {
        return errorResult("INVALID_GIT_PATH", "Tool operation failed: INVALID_GIT_PATH.");
      }
      let limit: number;
      try {
        limit = positiveBoundedInteger(
          input.args.limit,
          GIT_STATUS_DEFAULT_LIMIT,
          GIT_STATUS_MAX_LIMIT,
        );
      } catch {
        return errorResult("INVALID_GIT_SCOPE", "Tool operation failed: INVALID_GIT_SCOPE.");
      }

      try {
        // The canonical argument shape. The adapter reads exactly `path` and `limit` from it, so no
        // extra Runtime option can be smuggled through the bag.
        const result = await operations.status({
          environment: input.environment,
          args: { ...(path === undefined ? {} : { path }), limit },
          signal: input.signal,
        });
        const clean = result.clean === true;
        const entries = Array.isArray(result.entries) ? result.entries : [];
        const content = clean
          ? "Working tree is clean."
          : entries
              .map((entry) => {
                const item = entry as {
                  readonly indexStatus?: unknown;
                  readonly worktreeStatus?: unknown;
                  readonly path?: unknown;
                };
                return `${String(item.indexStatus ?? "")}${String(item.worktreeStatus ?? "")} ${String(item.path ?? "")}`;
              })
              .join("\n");
        return successResult(content, {
          ...(typeof result.branch === "string" ? { branch: result.branch } : {}),
          detached: result.detached === true,
          ahead: typeof result.ahead === "number" ? result.ahead : 0,
          behind: typeof result.behind === "number" ? result.behind : 0,
          clean,
          entries: entries.map((entry) => ({ ...(entry as Record<string, unknown>) })) as never,
          truncated: result.truncated === true,
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
      requiredCapabilities: ["GIT_READ"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectGitStatusSecurityFacts),
    promptSnippet: GIT_STATUS_PROMPT_SNIPPET,
  };
}

export { inputSchema as gitStatusInputSchema };
