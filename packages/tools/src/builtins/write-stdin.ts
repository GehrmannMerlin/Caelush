import type { ToolDefinition } from "@caelush/protocol";
import {
  RuntimeProcessStaleSessionError,
  RuntimeProcessUncertainError,
  DEFAULT_EXEC_YIELD_TIME_MS,
  MAX_EXEC_MODEL_OUTPUT_BYTES,
  resolveInteractionYield,
  type RuntimeResolver,
} from "@caelush/runtime";
import { ToolExecutionUncertainError } from "../errors.js";
import type { ToolExecutionRequest, ToolHandler } from "../handler.js";
import type { ToolRegistration } from "../registration.js";
import { projectStdinEffects } from "../tool-effects.js";
import { boundToolModelContent, DEFAULT_TOOL_OUTPUT_POLICY } from "../output-policy.js";
import { EXEC_OUTPUT_SCHEMA, errorResult, successResult, withRuntimeScope } from "./result.js";
import { projectWriteStdinSecurityFacts } from "./security-facts.js";
import { createBuiltinToolModelGuidance } from "../model-guidance.js";

const definition: ToolDefinition = {
  name: "write_stdin",
  description: "Poll process.",
  inputSchema: {
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
  },
  outputSchema: EXEC_OUTPUT_SCHEMA,
  riskLevel: "CRITICAL",
  requiredCapabilities: ["SHELL_EXEC", "PROCESS_START", "PROCESS_KILL"],
  runtimeRequirements: { runtimeKinds: ["local"] },
};

export function createWriteStdinRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const handler: ToolHandler = {
    execute: async (request) => executeWriteStdin(request, runtimeResolver),
  };
  return {
    definition,
    handler,
    effectProjector: projectStdinEffects,
    securityFactsProjector: projectWriteStdinSecurityFacts,
    modelGuidance: createBuiltinToolModelGuidance("write_stdin"),
  };
}

async function executeWriteStdin(request: ToolExecutionRequest, resolver: RuntimeResolver) {
  const args = request.args as { session_id?: unknown; chars?: unknown; yield_time_ms?: unknown };
  if (typeof args.session_id !== "string")
    return errorResult(
      "PROCESS_SESSION_NOT_FOUND",
      "Tool operation failed: PROCESS_SESSION_NOT_FOUND.",
    );
  if (args.chars !== undefined && typeof args.chars !== "string")
    return errorResult("INVALID_STDIN", "Tool operation failed: INVALID_STDIN.");
  const chars = args.chars ?? "";
  let yieldTimeMs: number;
  try {
    yieldTimeMs = resolveInteractionYield(args.yield_time_ms, chars);
  } catch {
    return errorResult("INVALID_YIELD_TIME", "Tool operation failed: INVALID_YIELD_TIME.");
  }
  try {
    return await withRuntimeScope(request, resolver, async (scope) => {
      const result = await scope.exec.interact({
        ownerRunId: request.runId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        sessionId: args.session_id as string,
        chars,
        yieldTimeMs,
      });
      const status =
        result.status === "RUNNING"
          ? `Process is still running (session_id=${result.sessionId}).`
          : `Process exited${result.exitCode === undefined ? "" : ` with exit code ${result.exitCode}`}.`;
      return successResult(
        boundToolModelContent(`${result.output || "(no new output)"}\n\n${status}`, {
          ...DEFAULT_TOOL_OUTPUT_POLICY,
          maxModelContentBytes: MAX_EXEC_MODEL_OUTPUT_BYTES,
        }),
        {
          status: result.status,
          ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
          ...(result.signal === undefined ? {} : { signal: result.signal }),
          totalOutputBytes: result.totalOutputBytes,
          omittedBytes: result.omittedBytes,
          tty: result.tty ?? false,
          ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
          ...(result.charsAcceptedBytes === undefined
            ? {}
            : { charsAcceptedBytes: result.charsAcceptedBytes }),
        },
      );
    });
  } catch (error) {
    if (
      error instanceof RuntimeProcessStaleSessionError ||
      error instanceof RuntimeProcessUncertainError
    ) {
      throw new ToolExecutionUncertainError();
    }
    throw error;
  }
}

export { definition as writeStdinDefinition };
