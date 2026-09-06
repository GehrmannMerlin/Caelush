import type { ToolDefinition } from "@caelush/protocol";
import type { RuntimeResolver } from "@caelush/runtime";
import type { ToolHandler, ToolExecutionRequest } from "../handler.js";
import type { ToolRegistration } from "../registration.js";
import {
  LIST_DIRECTORY_DEFAULT_LIMIT,
  LIST_DIRECTORY_MAX_LIMIT,
  READ_ONLY_OUTPUT_SCHEMA,
  errorResult,
  positiveBoundedInteger,
  successResult,
  withRuntimeScope,
} from "./result.js";
import { projectListDirectorySecurityFacts } from "./security-facts.js";
import { createBuiltinToolModelGuidance } from "../model-guidance.js";

const definition: ToolDefinition = {
  name: "list_directory",
  description: "List dir.",
  inputSchema: {
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
  },
  outputSchema: READ_ONLY_OUTPUT_SCHEMA,
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { runtimeKinds: ["local"] },
};

export function createListDirectoryRegistration(
  runtimeResolver: RuntimeResolver,
): ToolRegistration {
  const handler: ToolHandler = {
    execute: async (request) => executeListDirectory(request, runtimeResolver),
  };
  return {
    definition,
    handler,
    securityFactsProjector: projectListDirectorySecurityFacts,
    modelGuidance: createBuiltinToolModelGuidance("list_directory"),
  };
}

async function executeListDirectory(request: ToolExecutionRequest, resolver: RuntimeResolver) {
  const args = request.args as { path?: unknown; offset?: unknown; limit?: unknown };
  if (typeof args.path !== "string")
    return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
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
  return withRuntimeScope(request, resolver, async (scope) => {
    const resolved = await scope.pathResolver.resolveExisting(args.path as string);
    const targetMetadata =
      resolved.kind === "SYMLINK"
        ? await scope.filesystem.getMetadata(resolved.realPath)
        : resolved.metadata;
    if (targetMetadata === null)
      return errorResult("PATH_NOT_FOUND", "Tool operation failed: PATH_NOT_FOUND.");
    if (targetMetadata.kind !== "DIRECTORY")
      return errorResult("NOT_A_DIRECTORY", "Tool operation failed: NOT_A_DIRECTORY.");
    const entries = await scope.filesystem.readDirectory(resolved.absolutePath);
    const sliced = entries.slice(offset - 1, offset - 1 + limit);
    const items = sliced.map((entry) => ({
      name: entry.name,
      path: resolved.relativePath === "." ? entry.name : `${resolved.relativePath}/${entry.name}`,
      kind: entry.kind,
    }));
    const lines = items.map(
      (entry) =>
        `${entry.name}${entry.kind === "DIRECTORY" ? "/" : entry.kind === "SYMLINK" ? "@" : ""}`,
    );
    const truncated = offset - 1 + sliced.length < entries.length;
    return successResult(lines.length === 0 ? "(empty directory)" : lines.join("\n"), {
      path: resolved.relativePath,
      offset,
      count: items.length,
      truncated,
      entries: items,
      ...(truncated ? { nextOffset: offset + sliced.length } : {}),
    });
  });
}
