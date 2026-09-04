import type { ToolDefinition } from "@caelush/protocol";
import {
  RuntimeProcessStaleSessionError,
  RuntimeProcessUncertainError,
  MAX_EXEC_MODEL_OUTPUT_BYTES,
  resolveExecYield,
  type RuntimeExecResult,
  type RuntimeResolver,
} from "@caelush/runtime";
import { ToolExecutionUncertainError } from "../errors.js";
import type { ToolExecutionRequest, ToolHandler } from "../handler.js";
import type { ToolRegistration } from "../registration.js";
import { projectExecEffects } from "../tool-effects.js";
import { boundToolModelContent, DEFAULT_TOOL_OUTPUT_POLICY } from "../output-policy.js";
import { EXEC_OUTPUT_SCHEMA, errorResult, successResult, withRuntimeScope } from "./result.js";
import { projectExecCommandSecurityFacts } from "./security-facts.js";
import { createBuiltinToolModelGuidance } from "../model-guidance.js";

const definition: ToolDefinition = {
  name: "exec_command",
  description:
    "Executes a local shell command in a workspace-relative directory and returns bounded output. A still-running command can be continued with write_stdin.",
  inputSchema: {
    type: "object",
    properties: {
      cmd: { type: "string", minLength: 1, description: "Shell command to execute." },
      workdir: {
        type: "string",
        minLength: 1,
        description: "Workspace-relative working directory.",
      },
      tty: { type: "boolean", description: "Use a terminal-backed process." },
      yield_time_ms: { type: "integer", minimum: 250, maximum: 30000 },
    },
    required: ["cmd"],
    additionalProperties: false,
  },
  outputSchema: EXEC_OUTPUT_SCHEMA,
  riskLevel: "CRITICAL",
  requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
  runtimeRequirements: { runtimeKinds: ["local"] },
};

export function createExecCommandRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const handler: ToolHandler = {
    execute: async (request) => executeExecCommand(request, runtimeResolver),
  };
  return {
    definition,
    handler,
    effectProjector: projectExecEffects,
    securityFactsProjector: projectExecCommandSecurityFacts,
    modelGuidance: createBuiltinToolModelGuidance("exec_command"),
  };
}

async function executeExecCommand(request: ToolExecutionRequest, resolver: RuntimeResolver) {
  const args = request.args as {
    cmd?: unknown;
    workdir?: unknown;
    tty?: unknown;
    yield_time_ms?: unknown;
  };
  if (typeof args.cmd !== "string")
    return errorResult("INVALID_COMMAND", "Tool operation failed: INVALID_COMMAND.");
  if (args.workdir !== undefined && typeof args.workdir !== "string")
    return errorResult("INVALID_COMMAND", "Tool operation failed: INVALID_COMMAND.");
  if (args.tty !== undefined && typeof args.tty !== "boolean")
    return errorResult("INVALID_COMMAND", "Tool operation failed: INVALID_COMMAND.");
  let yieldTimeMs: number;
  try {
    yieldTimeMs = resolveExecYield(args.yield_time_ms);
  } catch {
    return errorResult("INVALID_YIELD_TIME", "Tool operation failed: INVALID_YIELD_TIME.");
  }
  try {
    return await withRuntimeScope(request, resolver, async (scope) => {
      const result = await scope.exec.execute({
        ownerRunId: request.runId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        command: args.cmd as string,
        ...(args.workdir === undefined ? {} : { workdir: args.workdir as string }),
        tty: args.tty === true,
        yieldTimeMs,
      });
      return resultToToolResult(result, args.workdir as string | undefined, args.tty === true);
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

function resultToToolResult(result: RuntimeExecResult, workdir: string | undefined, tty: boolean) {
  const status =
    result.status === "RUNNING"
      ? `Process is still running (session_id=${result.sessionId}).`
      : `Process exited${result.exitCode === undefined ? "" : ` with exit code ${result.exitCode}`}${result.signal === undefined ? "" : ` by signal ${result.signal}`}.`;
  const content = boundToolModelContent(`${result.output || "(no new output)"}\n\n${status}`, {
    ...DEFAULT_TOOL_OUTPUT_POLICY,
    maxModelContentBytes: MAX_EXEC_MODEL_OUTPUT_BYTES,
  });
  return successResult(content, {
    status: result.status,
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    totalOutputBytes: result.totalOutputBytes,
    omittedBytes: result.omittedBytes,
    tty,
    workdir: workdir ?? ".",
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
  });
}

export { definition as execCommandDefinition };
