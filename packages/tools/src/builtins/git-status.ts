import type { ToolDefinition } from "@caelush/protocol";
import {
  GIT_STATUS_DEFAULT_LIMIT,
  GIT_STATUS_MAX_LIMIT,
  type RuntimeResolver,
} from "@caelush/runtime";
import type { ToolExecutionRequest, ToolHandler } from "../handler.js";
import type { ToolRegistration } from "../registration.js";
import { errorResult, positiveBoundedInteger, successResult, withRuntimeScope } from "./result.js";
import { projectGitStatusSecurityFacts } from "./security-facts.js";
import { createBuiltinToolModelGuidance } from "../model-guidance.js";

const definition: ToolDefinition = {
  name: "git_status",
  description: "Reads bounded Git status for the active workspace without changing the repository.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "Workspace-relative pathspec." },
      limit: { type: "integer", minimum: 1, maximum: GIT_STATUS_MAX_LIMIT },
    },
    additionalProperties: false,
  },
  outputSchema: {
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
  },
  riskLevel: "LOW",
  requiredCapabilities: ["GIT_READ"],
  runtimeRequirements: { runtimeKinds: ["local"] },
};

export function createGitStatusRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const handler: ToolHandler = {
    execute: async (request) => executeGitStatus(request, runtimeResolver),
  };
  return {
    definition,
    handler,
    securityFactsProjector: projectGitStatusSecurityFacts,
    modelGuidance: createBuiltinToolModelGuidance("git_status"),
  };
}

async function executeGitStatus(request: ToolExecutionRequest, resolver: RuntimeResolver) {
  const path = request.args.path;
  if (path !== undefined && typeof path !== "string")
    return errorResult("INVALID_GIT_PATH", "Tool operation failed: INVALID_GIT_PATH.");
  let limit: number;
  try {
    limit = positiveBoundedInteger(
      request.args.limit,
      GIT_STATUS_DEFAULT_LIMIT,
      GIT_STATUS_MAX_LIMIT,
    );
  } catch {
    return errorResult("INVALID_GIT_SCOPE", "Tool operation failed: INVALID_GIT_SCOPE.");
  }
  return withRuntimeScope(request, resolver, async (scope) => {
    const result = await scope.git.status({
      ...(path === undefined ? {} : { path }),
      limit,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return successResult(
      result.clean
        ? "Working tree is clean."
        : result.entries
            .map((entry) => `${entry.indexStatus}${entry.worktreeStatus} ${entry.path}`)
            .join("\n"),
      {
        ...(result.branch === undefined ? {} : { branch: result.branch }),
        detached: result.detached,
        ahead: result.ahead,
        behind: result.behind,
        clean: result.clean,
        entries: result.entries.map((entry) => ({ ...entry })),
        truncated: result.truncated,
      },
    );
  });
}

export { definition as gitStatusDefinition };
