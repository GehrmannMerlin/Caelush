import { ToolExecutionUncertainError } from "@caelush/agent";
import {
  MAX_EXEC_MODEL_OUTPUT_BYTES,
  RuntimeInvariantError,
  RuntimeProcessStaleSessionError,
  RuntimeProcessUncertainError,
} from "@caelush/runtime";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { ProcessOperations } from "../operations/operations.js";
import { projectStopProcessEffects } from "../effects/effect-projectors.js";
import { projectStopProcessSecurityFacts } from "../security/security-facts.js";
import { STOP_PROCESS_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
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
 * `stop_process` — terminate one managed process session this Run started.
 *
 * ```text
 * exec_command   start a process   →  session_id
 * write_stdin    observe it       →  output + status
 * stop_process   end it           →  EXITED / KILLED
 * ```
 *
 * ## Why this Tool exists at all
 *
 * A coding agent legitimately starts long-running services — a dev server it must probe, a watcher it
 * must let settle, a test server a verifier will call. Every one of those has to be stopped again, and
 * the Runtime already knows the only safe way to name one: the opaque session id it minted and the Run
 * that owns it. Without this Tool the model's remaining option is a shell-level kill
 * (`taskkill`, `pkill`, `killall`, `Stop-Process`), which cannot prove ownership of anything — and
 * which is now denied outright by the command policy. `stop_process` is the supported replacement,
 * not a convenience.
 *
 * ## The input is a session handle and nothing else
 *
 * `session_id` is the entire schema. No pid, no image name, no wildcard, no `all`, and no owner: a
 * model-supplied owner would let the model *assert* ownership it does not have, and the owner is
 * already known to the Tool as its own execution identity. That identity is passed to the Runtime as
 * `ownerRunId`, so a foreign session is rejected by the Runtime before anything is terminated.
 *
 * ## Uncertainty stops the chain
 *
 * A termination whose outcome cannot be confirmed maps to the canonical uncertain signal rather than
 * to an ordinary failure. A model that reads an ordinary failure will start the command again; the
 * whole point of the uncertain vocabulary is that it must not.
 */
const inputSchema = {
  type: "object",
  properties: {
    session_id: {
      type: "string",
      minLength: 1,
      description: "Opaque managed process session ID returned by exec_command.",
    },
  },
  required: ["session_id"],
  additionalProperties: false,
} as const;

export function createStopProcessTool(operations: ProcessOperations): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "stop_process",
    description: "Stop managed process.",
    inputSchema,
    resultDetailsSchema: EXEC_OUTPUT_SCHEMA,
    execute: async (input): Promise<AgentToolResult> => {
      const args = input.args as { session_id?: unknown };
      if (typeof args.session_id !== "string" || args.session_id.length === 0) {
        return errorResult(
          "PROCESS_SESSION_NOT_FOUND",
          "Tool operation failed: PROCESS_SESSION_NOT_FOUND.",
        );
      }
      try {
        const result = await operations.terminate({
          environment: input.environment,
          ...(input.securityContext === undefined
            ? {}
            : { securityContext: input.securityContext }),
          ownerRunId: input.identity.runId,
          sessionId: args.session_id,
        });
        return resultToToolResult(result, args.session_id);
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
      requiredCapabilities: ["PROCESS_KILL"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectStopProcessSecurityFacts),
    effectProjector: asOverlayEffectProjector(projectStopProcessEffects),
    promptSnippet: STOP_PROCESS_PROMPT_SNIPPET,
  };
}

/** Project one Runtime termination result onto the Tool's model-facing result. */
function resultToToolResult(result: Record<string, unknown>, sessionId: string): AgentToolResult {
  const status = result.status;
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
  const signal = typeof result.signal === "string" ? result.signal : undefined;
  const output = typeof result.output === "string" ? result.output : "";
  const terminated = status === "EXITED";
  const summary = terminated
    ? `Process terminated (session_id=${sessionId}${signal === undefined ? "" : `, signal ${signal}`}${exitCode === undefined ? "" : `, exit code ${exitCode}`}).`
    : `Process is still running (session_id=${sessionId}).`;
  const content = boundToolModelContent(`${output || "(no new output)"}\n\n${summary}`, {
    ...DEFAULT_TOOL_OUTPUT_POLICY,
    maxModelContentBytes: MAX_EXEC_MODEL_OUTPUT_BYTES,
  });
  return successResult(content, {
    status: terminated ? "EXITED" : "RUNNING",
    sessionId,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    totalOutputBytes: typeof result.totalOutputBytes === "number" ? result.totalOutputBytes : 0,
    omittedBytes: typeof result.omittedBytes === "number" ? result.omittedBytes : 0,
    tty: result.tty === true,
    ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
  });
}

export { inputSchema as stopProcessInputSchema };
