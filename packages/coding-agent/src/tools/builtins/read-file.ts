import type { ToolExecutionEnvironment } from "@caelush/agent";
import { RuntimeInvariantError } from "@caelush/runtime";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { ReadFileOperations } from "../operations/operations.js";
import { projectReadFileEffect } from "../effects/effect-projectors.js";
import { projectReadFileSecurityFacts } from "../security/security-facts.js";
import { READ_FILE_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { defineCodingTool } from "./define-coding-tool.js";
import {
  errorResult,
  positiveBoundedInteger,
  READ_FILE_DEFAULT_LIMIT,
  READ_FILE_MAX_LIMIT,
  READ_ONLY_OUTPUT_SCHEMA,
  runtimeErrorToResult,
  successResult,
  asOverlaySecurityFactsProjector,
  asOverlayEffectProjector,
  type AgentToolResult,
} from "./result.js";

/**
 * `read_file` — read bounded text from one workspace file.
 *
 * ```text
 * factory(operations)  →  CodingToolDefinition
 *                            tool                 the canonical AgentTool
 *                            security             LOW / FS_READ
 *                            securityFactsProjector  READ access on the requested path
 *                            effectProjector      FILE_READ on the resolved path
 *                            promptSnippet        usage guidance, delivered through Context
 * ```
 *
 * ## Operations arrive by closure, not by field
 *
 * `CodingToolDefinition` deliberately has no `operations` field. The port is captured by this factory
 * and closed over by `execute`, so the definition stays data and the capability stays inside the one
 * function that needs it. A host that holds a definition cannot reach the filesystem through it.
 *
 * ## Behaviour is unchanged from the legacy builtin
 *
 * Same name, same description, same input schema, same defaults and bounds, same details shape, same
 * failure codes. The migration moves *who owns the implementation* and *how it reaches the machine*,
 * and deliberately changes nothing a model or a caller can observe.
 */
const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, description: "Workspace-relative file path." },
    offset: {
      type: "integer",
      minimum: 1,
      default: 1,
      description: "1-indexed first line to return; defaults to 1.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: READ_FILE_MAX_LIMIT,
      default: READ_FILE_DEFAULT_LIMIT,
      description: `Maximum number of returned lines; defaults to ${READ_FILE_DEFAULT_LIMIT}.`,
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

export function createReadFileTool(operations: ReadFileOperations): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "read_file",
    description: "Read workspace text.",
    inputSchema,
    resultDetailsSchema: READ_ONLY_OUTPUT_SCHEMA,
    execute: async (input): Promise<AgentToolResult> => {
      const args = input.args as { path?: unknown; offset?: unknown; limit?: unknown };
      let offset: number;
      let limit: number;
      try {
        offset = positiveBoundedInteger(args.offset, 1, Number.MAX_SAFE_INTEGER);
        limit = positiveBoundedInteger(args.limit, READ_FILE_DEFAULT_LIMIT, READ_FILE_MAX_LIMIT);
      } catch {
        return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
      }
      if (typeof args.path !== "string") {
        return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
      }

      try {
        const read = await operations.read({
          environment: input.environment,
          path: args.path,
          offset,
          limit: limit,
          signal: input.signal,
        });
        const details = {
          path: read.path,
          offset,
          linesReturned: read.lines.length,
          truncated: read.truncated,
          ...(read.nextOffset === undefined ? {} : { nextOffset: read.nextOffset }),
          bytesReturned: read.bytesReturned,
          utf8Bom: read.utf8Bom,
        };
        const content = read.lines.length === 0 ? "(empty file)" : read.lines.join("\n");
        return successResult(content, details);
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
    securityFactsProjector: asOverlaySecurityFactsProjector(projectReadFileSecurityFacts),
    effectProjector: asOverlayEffectProjector(projectReadFileEffect),
    promptSnippet: READ_FILE_PROMPT_SNIPPET,
  };
}

export { inputSchema as readFileInputSchema };

/** The environment locator type this Tool's operations receive, re-exported for the guard. */
export type ReadFileToolEnvironment = ToolExecutionEnvironment;
