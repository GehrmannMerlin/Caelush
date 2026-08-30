import type { ToolDefinition } from "@caelush/protocol";
import { type GitDiffScope, type RuntimeResolver } from "@caelush/runtime";
import type { ToolExecutionRequest, ToolHandler } from "../handler.js";
import type { ToolRegistration } from "../registration.js";
import { errorResult, successResult, withRuntimeScope } from "./result.js";
import { projectGitDiffSecurityFacts } from "./security-facts.js";

const definition: ToolDefinition = {
  name: "git_diff",
  description: "Reads a bounded, read-only Git diff for the active workspace.",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["WORKTREE", "STAGED", "ALL"] },
      path: { type: "string", minLength: 1, description: "Workspace-relative pathspec." },
    },
    additionalProperties: false,
  },
  outputSchema: {
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
  },
  riskLevel: "LOW",
  requiredCapabilities: ["GIT_READ"],
  runtimeRequirements: { runtimeKinds: ["local"] },
};

export function createGitDiffRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const handler: ToolHandler = {
    execute: async (request) => executeGitDiff(request, runtimeResolver),
  };
  return { definition, handler, securityFactsProjector: projectGitDiffSecurityFacts };
}

async function executeGitDiff(request: ToolExecutionRequest, resolver: RuntimeResolver) {
  const scope = request.args.scope;
  const path = request.args.path;
  const invalidScope =
    scope !== undefined && scope !== "WORKTREE" && scope !== "STAGED" && scope !== "ALL";
  const invalidPath = path !== undefined && typeof path !== "string";
  if (invalidScope || invalidPath) {
    const code = invalidScope ? "INVALID_GIT_SCOPE" : "INVALID_GIT_PATH";
    return errorResult(code, `Tool operation failed: ${code}.`);
  }
  return withRuntimeScope(request, resolver, async (runtimeScope) => {
    const result = await runtimeScope.git.diff({
      ...(scope === undefined ? {} : { scope: scope as GitDiffScope }),
      ...(path === undefined ? {} : { path }),
    });
    return successResult(result.diff || "No changes.", {
      scope: result.scope,
      path: result.path,
      truncated: result.truncated,
      bytesReturned: result.bytesReturned,
      omittedBytes: result.omittedBytes,
      hadDecodeReplacement: result.hadDecodeReplacement,
    });
  });
}

export { definition as gitDiffDefinition };
