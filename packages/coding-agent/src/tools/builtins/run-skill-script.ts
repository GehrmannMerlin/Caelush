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
import {
  SkillOperationError,
  unavailableSkillScriptAdapter,
  type SkillOperations,
} from "../operations/skill-operations.js";
import { projectExecEffects } from "../effects/effect-projectors.js";
import { RUN_SKILL_SCRIPT_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { projectRunSkillScriptSecurityFacts } from "../security/security-facts.js";
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

export const runSkillScriptInputSchema = {
  type: "object",
  properties: {
    bindingId: { type: "string", minLength: 1, maxLength: 256 },
    resourcePath: { type: "string", minLength: 1, maxLength: 1024 },
    args: {
      type: "array",
      maxItems: 64,
      items: { type: "string", maxLength: 4096 },
    },
    workdir: { type: "string", minLength: 1, maxLength: 1024 },
    yieldTimeMs: {
      type: "integer",
      minimum: 250,
      maximum: 30000,
      default: DEFAULT_EXEC_YIELD_TIME_MS,
    },
  },
  required: ["bindingId", "resourcePath", "args"],
  additionalProperties: false,
} as const;

/** The fixed definition is executable only when its host supplies a verified Skill Operations adapter. */
export function createRunSkillScriptTool(
  runScript: SkillOperations["runScript"] = unavailableSkillScriptAdapter,
): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "run_skill_script",
    description: "Run a script from a loaded Skill bundle when script execution is available.",
    scheduling: { class: "UNKNOWN" },
    inputSchema: runSkillScriptInputSchema,
    resultDetailsSchema: EXEC_OUTPUT_SCHEMA,
    execute: async (input): Promise<AgentToolResult> => {
      const args = input.args as {
        bindingId?: unknown;
        resourcePath?: unknown;
        args?: unknown;
        workdir?: unknown;
        yieldTimeMs?: unknown;
      };
      if (
        typeof args.bindingId !== "string" ||
        args.bindingId.length === 0 ||
        typeof args.resourcePath !== "string" ||
        args.resourcePath.length === 0 ||
        !Array.isArray(args.args) ||
        args.args.some((value) => typeof value !== "string")
      ) {
        return errorResult("SKILL_SCRIPT_INVALID", "Skill script request is invalid.");
      }
      if (args.workdir !== undefined && typeof args.workdir !== "string") {
        return errorResult("SKILL_SCRIPT_INVALID", "Skill script working directory is invalid.");
      }
      let yieldTimeMs: number;
      try {
        yieldTimeMs = resolveExecYield(args.yieldTimeMs);
      } catch {
        return errorResult("INVALID_YIELD_TIME", "Tool operation failed: INVALID_YIELD_TIME.");
      }

      try {
        const result = await runScript(
          {
            runId: input.identity.runId,
            bindingId: args.bindingId,
            resourcePath: args.resourcePath,
            args: args.args as readonly string[],
            ...(args.workdir === undefined ? {} : { workdir: args.workdir }),
            yieldTimeMs,
            signal: input.signal,
            onOutput: (stream, chunk) => input.updates.publish({ kind: "OUTPUT", stream, chunk }),
          },
          {
            identity: input.identity,
            environment: input.environment,
            ...(input.securityContext === undefined
              ? {}
              : { securityContext: input.securityContext }),
          },
        );
        if (result.kind === "UNAVAILABLE") {
          return errorResult(
            "SCRIPT_EXECUTION_UNAVAILABLE",
            "Skill script execution is unavailable in this environment.",
          );
        }
        return resultToToolResult(result);
      } catch (error) {
        if (error instanceof SkillOperationError) return errorResult(error.code, error.message);
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
    securityFactsProjector: asOverlaySecurityFactsProjector(projectRunSkillScriptSecurityFacts),
    effectProjector: asOverlayEffectProjector(projectExecEffects),
    promptSnippet: RUN_SKILL_SCRIPT_PROMPT_SNIPPET,
  };
}

function resultToToolResult(
  result: Exclude<Awaited<ReturnType<SkillOperations["runScript"]>>, { kind: "UNAVAILABLE" }>,
): AgentToolResult {
  const summary =
    result.status === "RUNNING"
      ? `Process is still running (session_id=${result.sessionId ?? ""}).`
      : `Process exited${result.exitCode === undefined ? "" : ` with exit code ${result.exitCode}`}${result.signal === undefined ? "" : ` by signal ${result.signal}`}.`;
  const content = boundToolModelContent(`${result.output || "(no new output)"}\n\n${summary}`, {
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
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
  });
}
