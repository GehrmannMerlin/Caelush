import type { ToolExecutionEnvironment } from "@caelush/agent";
import { RuntimeInvariantError } from "@caelush/runtime";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { CodingReadOnlyOperations } from "../operations/coding-read-only-operations.js";
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

/** The one port this Tool needs, so its own read is the only capability it can reach. */
type ReadFileProbeOperations = Pick<CodingReadOnlyOperations, "readFileWithKind">;

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

export function createReadFileTool(operations: ReadFileProbeOperations): CodingToolDefinition {
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
        // The port reports what the path resolved to. `NOT_A_FILE` is this Tool's own model-facing
        // decision about that fact, which is why it is made here and not mapped from a Runtime error
        // code: a Tool may not import the Runtime's error vocabulary to interpret a path kind.
        const read = await operations.readFileWithKind({
          environment: input.environment,
          path: args.path,
          offset,
          limit: limit,
          signal: input.signal,
        });
        if (read.kind === "MISSING") {
          return errorResult("PATH_NOT_FOUND", "Tool operation failed: PATH_NOT_FOUND.");
        }
        if (read.read === undefined) {
          return errorResult("NOT_A_FILE", "Tool operation failed: NOT_A_FILE.");
        }
        const details = {
          path: read.path,
          offset,
          linesReturned: read.read.lines.length,
          truncated: read.read.truncated,
          ...(read.read.nextOffset === undefined ? {} : { nextOffset: read.read.nextOffset }),
          bytesReturned: read.read.bytesReturned,
          utf8Bom: read.read.utf8Bom,
        };
        const content = read.read.lines.length === 0 ? "(empty file)" : read.read.lines.join("\n");
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
