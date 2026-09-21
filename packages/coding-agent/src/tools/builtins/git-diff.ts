import { RuntimeInvariantError, type GitDiffScope } from "@caelush/runtime";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { GitOperations } from "../operations/operations.js";
import { projectGitDiffSecurityFacts } from "../security/security-facts.js";
import { GIT_DIFF_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { defineCodingTool } from "./define-coding-tool.js";
import {
  errorResult,
  runtimeErrorToResult,
  successResult,
  asOverlaySecurityFactsProjector,
  type AgentToolResult,
} from "./result.js";

/**
 * `git_diff` — read a bounded Git diff.
 *
 * ## The `args` arm was already correct
 *
 * Unlike `status`, the `diff` arm of the frozen `GitOperations` always carried `args`, and the freeze
 * explicitly allowed both `scope` and `path` through it. So this Tool needed no correction: it passes
 * the canonical `{ scope?, path? }` shape, the adapter forwards it to `RuntimeGitService.diff`, and Git
 * applies the scope and the pathspec.
 *
 * The `status` correction made the two arms symmetric; it did not change this one.
 *
 * ## Truncation is reported, never hidden
 *
 * A bounded diff reports `truncated`, `bytesReturned`, `omittedBytes` and `hadDecodeReplacement`, so a
 * model can tell a complete review from a partial one. `scope: "ALL"` renders both halves with their
 * `=== WORKTREE ===` / `=== STAGED ===` headers, which is the Runtime's own framing.
 *
 * ## Behaviour is unchanged
 *
 * Same name, description, input schema, defaults, details shape and failure codes.
 */
const inputSchema = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["WORKTREE", "STAGED", "ALL"],
      default: "ALL",
      description: "Diff scope; defaults to ALL.",
    },
    path: { type: "string", minLength: 1, description: "Workspace-relative pathspec." },
  },
  additionalProperties: false,
} as const;

const resultDetailsSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    scope: { type: "string", enum: ["WORKTREE", "STAGED", "ALL"] },
    path: { type: "string" },
    truncated: { type: "boolean" },
    bytesReturned: { type: "integer", minimum: 0 },
    omittedBytes: { type: "integer", minimum: 0 },
    hadDecodeReplacement: { type: "boolean" },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

export function createGitDiffTool(operations: GitOperations): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "git_diff",
    description: "Git.",
    inputSchema,
    resultDetailsSchema,
    execute: async (input): Promise<AgentToolResult> => {
      const scope = input.args.scope;
      const path = input.args.path;
      const invalidScope =
        scope !== undefined && scope !== "WORKTREE" && scope !== "STAGED" && scope !== "ALL";
      const invalidPath = path !== undefined && typeof path !== "string";
      if (invalidScope || invalidPath) {
        const code = invalidScope ? "INVALID_GIT_SCOPE" : "INVALID_GIT_PATH";
        return errorResult(code, `Tool operation failed: ${code}.`);
      }

      try {
        const result = await operations.diff({
          environment: input.environment,
          args: {
            ...(scope === undefined ? {} : { scope: scope as GitDiffScope }),
            ...(path === undefined ? {} : { path }),
          },
          signal: input.signal,
        });
        return successResult(
          typeof result.diff === "string" && result.diff !== "" ? result.diff : "No changes.",
          {
            scope: typeof result.scope === "string" ? result.scope : (scope ?? "ALL"),
            path: typeof result.path === "string" ? result.path : ".",
            truncated: result.truncated === true,
            bytesReturned: typeof result.bytesReturned === "number" ? result.bytesReturned : 0,
            omittedBytes: typeof result.omittedBytes === "number" ? result.omittedBytes : 0,
            hadDecodeReplacement: result.hadDecodeReplacement === true,
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
      requiredCapabilities: ["GIT_READ"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectGitDiffSecurityFacts),
    promptSnippet: GIT_DIFF_PROMPT_SNIPPET,
  };
}

export { inputSchema as gitDiffInputSchema };
