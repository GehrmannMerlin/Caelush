import type { ToolExecutionUpdate } from "@caelush/agent";
import { ToolExecutionUncertainError } from "@caelush/agent";
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  MAX_EXEC_MODEL_OUTPUT_BYTES,
  RuntimeInvariantError,
  RuntimeProcessStaleSessionError,
  RuntimeProcessUncertainError,
  resolveInteractionYield,
} from "@caelush/runtime";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { ProcessOperations } from "../operations/operations.js";
import { projectStdinEffects } from "../effects/effect-projectors.js";
import { projectWriteStdinSecurityFacts } from "../security/security-facts.js";
import { WRITE_STDIN_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { boundToolModelContent, DEFAULT_TOOL_OUTPUT_POLICY } from "../output/output-policy.js";
import { defineCodingTool } from "./define-coding-tool.js";
import {
  errorResult,
  EXEC_OUTPUT_SCHEMA,
  runtimeErrorToResult,
  successResult,
  asOverlaySecurityFactsProjector,
  asOverlayEffectProjector,
  type AgentToolResult,
} from "./result.js";

/**
 * `write_stdin` — write to, or poll, a running process.
 *
 * ## Empty `chars` is a legitimate poll
 *
 * `chars: ""` asks for whatever the process produced since the last look, and it is one of the Tool's
 * two normal modes rather than an edge case. It is also why the default yield differs between a write
 * and a poll: `resolveInteractionYield` picks the appropriate default from whether anything is being
 * written.
 *
 * ## Same-Run ownership is enforced by the Runtime
 *
 * The Tool passes its own Run identity as `ownerRunId`, and the Runtime refuses a session another Run
 * started. The Tool does not compare ids itself: a session id is opaque, so only the Runtime can decide
 * ownership.
 *
 * ## Uncertainty stops the chain
 *
 * A stale or uncertain session maps to the canonical uncertain signal. Downgrading it to a plain
 * `PROCESS_SESSION_NOT_FOUND` would invite the model to start the command again, which is exactly the
 * duplicate execution the uncertain vocabulary exists to prevent.
 *
 * ## Behaviour is unchanged
 *
 * Same name, description, input schema, defaults, bounds, details shape and failure codes.
 */
const inputSchema = {
  type: "object",
  properties: {
    session_id: { type: "string", minLength: 1, description: "Opaque process session ID." },
    chars: {
      type: "string",
      default: "",
      description: "Characters to write; omit or use empty text to poll.",
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
  required: ["session_id"],
  additionalProperties: false,
} as const;

export function createWriteStdinTool(operations: ProcessOperations): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "write_stdin",
    description: "Poll process.",
    inputSchema,
    resultDetailsSchema: EXEC_OUTPUT_SCHEMA,
    execute: async (input): Promise<AgentToolResult> => {
      const args = input.args as {
        session_id?: unknown;
        chars?: unknown;
        yield_time_ms?: unknown;
      };
      if (typeof args.session_id !== "string") {
        return errorResult(
          "PROCESS_SESSION_NOT_FOUND",
          "Tool operation failed: PROCESS_SESSION_NOT_FOUND.",
        );
      }
      if (args.chars !== undefined && typeof args.chars !== "string") {
        return errorResult("INVALID_STDIN", "Tool operation failed: INVALID_STDIN.");
      }
      const chars = args.chars ?? "";
      let yieldTimeMs: number;
      try {
        yieldTimeMs = resolveInteractionYield(args.yield_time_ms, chars);
      } catch {
        return errorResult("INVALID_YIELD_TIME", "Tool operation failed: INVALID_YIELD_TIME.");
      }

      try {
        const result = await operations.interact({
          environment: input.environment,
          ownerRunId: input.identity.runId,
          sessionId: args.session_id,
          chars,
          yieldTimeMs,
          signal: input.signal,
          onOutput: (stream, chunk) => {
            const update: ToolExecutionUpdate = { kind: "OUTPUT", stream, chunk };
            input.updates.publish(update);
          },
        });
        return resultToToolResult(result);
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
      requiredCapabilities: ["SHELL_EXEC", "PROCESS_START", "PROCESS_KILL"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectWriteStdinSecurityFacts),
    effectProjector: asOverlayEffectProjector(projectStdinEffects),
    promptSnippet: WRITE_STDIN_PROMPT_SNIPPET,
  };
}

/** Project one Runtime interaction result onto the Tool's model-facing result. */
function resultToToolResult(result: Record<string, unknown>): AgentToolResult {
  const status = result.status;
  const sessionId = typeof result.sessionId === "string" ? result.sessionId : undefined;
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
  const signal = typeof result.signal === "string" ? result.signal : undefined;
  const output = typeof result.output === "string" ? result.output : "";
  const summary =
    status === "RUNNING"
      ? `Process is still running (session_id=${sessionId ?? ""}).`
      : `Process exited${exitCode === undefined ? "" : ` with exit code ${exitCode}`}.`;
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
    tty: result.tty === true,
    ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
    ...(typeof result.charsAcceptedBytes === "number"
      ? { charsAcceptedBytes: result.charsAcceptedBytes }
      : {}),
  });
}

export { inputSchema as writeStdinInputSchema };
