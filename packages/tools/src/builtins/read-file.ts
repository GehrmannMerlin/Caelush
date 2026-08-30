import type { ToolDefinition } from "@caelush/protocol";
import { RuntimeInvalidRangeError, type RuntimeResolver } from "@caelush/runtime";
import type { ToolHandler, ToolExecutionRequest } from "../handler.js";
import type { ToolRegistration } from "../registration.js";
import { projectReadFileEffect } from "../tool-effects.js";
import { projectReadFileSecurityFacts } from "./security-facts.js";
import {
  READ_FILE_DEFAULT_LIMIT,
  READ_FILE_MAX_LIMIT,
  READ_ONLY_OUTPUT_SCHEMA,
  errorResult,
  positiveBoundedInteger,
  successResult,
  withRuntimeScope,
} from "./result.js";

const definition: ToolDefinition = {
  name: "read_file",
  description: "Reads a UTF-8 text file inside the active workspace. Paths are workspace-relative.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "Workspace-relative file path." },
      offset: { type: "integer", minimum: 1, description: "1-indexed first line to return." },
      limit: { type: "integer", minimum: 1, description: "Maximum number of returned lines." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: READ_ONLY_OUTPUT_SCHEMA,
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { runtimeKinds: ["local"] },
};

export function createReadFileRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const handler: ToolHandler = {
    execute: async (request) => executeReadFile(request, runtimeResolver),
  };
  return {
    definition,
    handler,
    effectProjector: projectReadFileEffect,
    securityFactsProjector: projectReadFileSecurityFacts,
  };
}

async function executeReadFile(request: ToolExecutionRequest, resolver: RuntimeResolver) {
  const args = request.args as { path?: unknown; offset?: unknown; limit?: unknown };
  let offset: number;
  let limit: number;
  try {
    offset = positiveBoundedInteger(args.offset, 1, Number.MAX_SAFE_INTEGER);
    limit = positiveBoundedInteger(args.limit, READ_FILE_DEFAULT_LIMIT, READ_FILE_MAX_LIMIT);
  } catch {
    return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
  }
  if (typeof args.path !== "string")
    return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
  return withRuntimeScope(request, resolver, async (scope) => {
    const resolved = await scope.pathResolver.resolveExisting(args.path as string);
    if (resolved.kind !== "FILE" && resolved.kind !== "SYMLINK")
      return errorResult("NOT_A_FILE", "Tool operation failed: NOT_A_FILE.");
    const read = await scope.filesystem.readTextFile(resolved.absolutePath, {
      offset,
      limit,
      maxBytes: 50 * 1024,
    });
    if (read.lines.length === 0 && offset > 1 && !read.truncated) {
      throw new RuntimeInvalidRangeError("line offset is outside the file");
    }
    const details = {
      path: resolved.relativePath,
      offset,
      linesReturned: read.lines.length,
      truncated: read.truncated,
      ...(read.nextOffset === undefined ? {} : { nextOffset: read.nextOffset }),
      bytesReturned: read.bytesReturned,
      utf8Bom: read.utf8Bom,
    };
    const content = read.lines.length === 0 ? "(empty file)" : read.lines.join("\n");
    return successResult(content, details);
  }).catch((error) => {
    if (error instanceof RuntimeInvalidRangeError)
      return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
    throw error;
  });
}
