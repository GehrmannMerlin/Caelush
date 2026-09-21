import type { ToolExecutionUpdate } from "@caelush/agent";
import { ToolExecutionUncertainError } from "@caelush/agent";
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  MAX_EXEC_MODEL_OUTPUT_BYTES,
  RuntimeInvariantError,
  RuntimeProcessStaleSessionError,
  RuntimeProcessUncertainError,
  resolveExecYield,
} from "@caelush/runtime";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { ExecOperations } from "../operations/operations.js";
import { projectExecEffects } from "../effects/effect-projectors.js";
import { projectExecCommandSecurityFacts } from "../security/security-facts.js";
import { EXEC_COMMAND_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { boundToolModelContent, DEFAULT_TOOL_OUTPUT_POLICY } from "../output/output-policy.js";
import { defineCodingTool } from "./define-coding-tool.js";
import {
  asOverlayEffectProjector,
  asOverlaySecurityFactsProjector,
  errorResult,
  EXEC_OUTPUT_SCHEMA,
  runtimeErrorToResult,
  successResult,
  type AgentToolResult,
} from "./result.js";

/**
 * `exec_command` — run a command.
 *
 * ## Transient output is wired, and honestly bounded
 *
 * The `ExecOperations.execute` contract carries an `onOutput` callback, and this Tool projects it onto
 * the canonical transient-update channel:
 *
 * ```text
 * onOutput(stream, chunk)  →  input.updates.publish({ kind: "OUTPUT", stream, chunk })
 * ```
 *
 * That is the whole integration, and it is real: the sanitizer, the orphan suppression and the
 * drain-before-terminal-event ordering all belong to the executor built in Phase 4B. A unit test with a
 * fake Operations implementation can already drive this path end to end.
 *
 * What is **not** claimed: the current `LocalRuntime` adapter has no live streaming source, so in
 * production this callback is never invoked. No polling fabricates chunks, and no Tool pretends to
 * stream. The seam exists so that a Runtime which later gains a live stream needs no Tool change.
 *
 * ## `yield_time_ms` is observation wait, not a timeout
 *
 * It bounds how long the caller waits before being told "still running". It never kills the process.
 *
 * ## Uncertain process state stops the chain
 *
 * A stale or uncertain process session means the command's fate cannot be proven, so it maps to the
 * canonical uncertain signal — never to an ordinary failure the model would retry. A known failed
 * spawn, by contrast, is an ordinary `isError` result.
 *
 * ## Behaviour is unchanged
 *
 * Same name, description, input schema, defaults, bounds, details shape and failure codes.
 */
const inputSchema = {
  type: "object",
  properties: {
    cmd: { type: "string", minLength: 1, description: "Shell command to execute." },
    workdir: {
      type: "string",
      minLength: 1,
      default: ".",
      description: "Workspace-relative working directory; defaults to the workspace root '.'.",
    },
    tty: {
      type: "boolean",
      default: false,
      description: "Use a terminal-backed process; defaults to false.",
    },
    yield_time_ms: {
      type: "integer",
      minimum: 250,
      maximum: 30000,
      default: DEFAULT_EXEC_YIELD_TIME_MS,
      description:
        "yield_time_ms is observation wait in milliseconds, not a timeout; defaults to 10000.",
    },
  },
  required: ["cmd"],
  additionalProperties: false,
} as const;

export function createExecCommandTool(operations: ExecOperations): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "exec_command",
    description: "Run command.",
    inputSchema,
    resultDetailsSchema: EXEC_OUTPUT_SCHEMA,
    execute: async (input): Promise<AgentToolResult> => {
      const args = input.args as {
        cmd?: unknown;
        workdir?: unknown;
        tty?: unknown;
        yield_time_ms?: unknown;
      };
      if (typeof args.cmd !== "string") {
        return errorResult("INVALID_COMMAND", "Tool operation failed: INVALID_COMMAND.");
      }
      if (args.workdir !== undefined && typeof args.workdir !== "string") {
        return errorResult("INVALID_COMMAND", "Tool operation failed: INVALID_COMMAND.");
      }
      if (args.tty !== undefined && typeof args.tty !== "boolean") {
        return errorResult("INVALID_COMMAND", "Tool operation failed: INVALID_COMMAND.");
      }
      let yieldTimeMs: number;
      try {
        yieldTimeMs = resolveExecYield(args.yield_time_ms);
      } catch {
        return errorResult("INVALID_YIELD_TIME", "Tool operation failed: INVALID_YIELD_TIME.");
      }

      try {
        const result = await operations.execute({
          environment: input.environment,
          ownerRunId: input.identity.runId,
          command: args.cmd,
          ...(args.workdir === undefined ? {} : { workdir: args.workdir }),
          tty: args.tty === true,
          yieldTimeMs,
          signal: input.signal,
          onOutput: (stream, chunk) => {
            const update: ToolExecutionUpdate = { kind: "OUTPUT", stream, chunk };
            input.updates.publish(update);
          },
        });
        return resultToToolResult(result, args.workdir, args.tty === true);
      } catch (error) {
        if (
          error instanceof RuntimeProcessStaleSessionError ||
          error instanceof RuntimeProcessUncertainError
        ) {
          throw new ToolExecutionUncertainError();
        }
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
      riskLevel: "CRITICAL",
      requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectExecCommandSecurityFacts),
    effectProjector: asOverlayEffectProjector(projectExecEffects),
    promptSnippet: EXEC_COMMAND_PROMPT_SNIPPET,
  };
}

/** Project one Runtime exec result onto the Tool's model-facing result. */
function resultToToolResult(
  result: Record<string, unknown>,
  workdir: unknown,
  tty: boolean,
): AgentToolResult {
  const status = result.status;
  const sessionId = typeof result.sessionId === "string" ? result.sessionId : undefined;
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
  const signal = typeof result.signal === "string" ? result.signal : undefined;
  const output = typeof result.output === "string" ? result.output : "";
  const summary =
    status === "RUNNING"
      ? `Process is still running (session_id=${sessionId ?? ""}).`
      : `Process exited${exitCode === undefined ? "" : ` with exit code ${exitCode}`}${signal === undefined ? "" : ` by signal ${signal}`}.`;
  const content = boundToolModelContent(`${output || "(no new output)"}\n\n${summary}`, {
    ...DEFAULT_TOOL_OUTPUT_POLICY,
    maxModelContentBytes: MAX_EXEC_MODEL_OUTPUT_BYTES,
  });
  return successResult(content, {
    status: status === "RUNNING" ? "RUNNING" : "EXITED",
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    totalOutputBytes: typeof result.totalOutputBytes === "number" ? result.totalOutputBytes : 0,
    omittedBytes: typeof result.omittedBytes === "number" ? result.omittedBytes : 0,
    tty,
    workdir: typeof workdir === "string" ? workdir : ".",
    ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
  });
}

export { inputSchema as execCommandInputSchema };
