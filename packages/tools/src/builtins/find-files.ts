import type { ToolDefinition } from "@caelush/protocol";
import {
  RuntimeInvalidPatternError,
  RuntimeInvalidRangeError,
  type RuntimeResolver,
} from "@caelush/runtime";
import type { ToolExecutionRequest, ToolHandler } from "../handler.js";
import type { ToolRegistration } from "../registration.js";
import {
  FIND_FILES_DEFAULT_LIMIT,
  FIND_FILES_MAX_LIMIT,
  MAX_FIND_PATTERN_BYTES,
  READ_ONLY_OUTPUT_SCHEMA,
  errorResult,
  positiveBoundedInteger,
  successResult,
  withRuntimeScope,
} from "./result.js";
import { projectFindFilesSecurityFacts } from "./security-facts.js";

const definition: ToolDefinition = {
  name: "find_files",
  description: "Finds files by a workspace-relative glob pattern.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 1, description: "Glob pattern for file discovery." },
      path: { type: "string", minLength: 1, description: "Workspace-relative search directory." },
      limit: { type: "integer", minimum: 1, description: "Maximum number of returned files." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  outputSchema: READ_ONLY_OUTPUT_SCHEMA,
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { runtimeKinds: ["local"] },
};

export function createFindFilesRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const handler: ToolHandler = {
    execute: async (request) => executeFindFiles(request, runtimeResolver),
  };
  return { definition, handler, securityFactsProjector: projectFindFilesSecurityFacts };
}

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

async function executeFindFiles(request: ToolExecutionRequest, resolver: RuntimeResolver) {
  const args = request.args as { pattern?: unknown; path?: unknown; limit?: unknown };
  let pattern: string;
  let limit: number;
  try {
    pattern = validatePattern(args.pattern);
    limit = positiveBoundedInteger(args.limit, FIND_FILES_DEFAULT_LIMIT, FIND_FILES_MAX_LIMIT);
  } catch (error) {
    const code = error instanceof RuntimeInvalidPatternError ? "INVALID_PATTERN" : "INVALID_RANGE";
    return errorResult(code, `Tool operation failed: ${code}.`);
  }
  const searchPath = args.path === undefined ? "." : args.path;
  if (typeof searchPath !== "string")
    return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
  return withRuntimeScope(request, resolver, async (scope) => {
    const resolved = await scope.pathResolver.resolveExisting(searchPath);
    if (resolved.kind !== "DIRECTORY")
      throw new RuntimeInvalidRangeError("search path is not a directory");
    const discovered = await scope.discovery.find({ cwd: resolved.absolutePath, pattern, limit });
    const files: string[] = [];
    for (const file of discovered.files) {
      const relative = resolved.relativePath === "." ? file : `${resolved.relativePath}/${file}`;
      const checked = await scope.pathResolver.resolveExisting(relative);
      if (checked.kind === "FILE") files.push(checked.relativePath);
    }
    return successResult(files.length === 0 ? "No files found." : files.join("\n"), {
      path: resolved.relativePath,
      pattern,
      count: files.length,
      truncated: discovered.truncated,
      files,
    });
  });
}
