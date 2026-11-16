import type { CodingToolDefinition } from "../coding-tool-definition.js";
import { unavailableSkillScriptAdapter } from "../operations/skill-operations.js";
import { RUN_SKILL_SCRIPT_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { projectRunSkillScriptSecurityFacts } from "../security/security-facts.js";
import { defineCodingTool } from "./define-coding-tool.js";
import { asOverlaySecurityFactsProjector, errorResult } from "./result.js";

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
    yieldTimeMs: { type: "integer", minimum: 1, maximum: 30000 },
  },
  required: ["bindingId", "resourcePath", "args"],
  additionalProperties: false,
} as const;

const runSkillScriptOutputSchema = {
  type: "object",
  properties: { ok: { type: "boolean" }, error: { type: "string" } },
  required: ["ok"],
  additionalProperties: false,
} as const;

/** The fixed definition is present only in isolated Skill-enabled compositions during Phase 05. */
export function createRunSkillScriptTool(): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "run_skill_script",
    description: "Run a script from a loaded Skill bundle when script execution is available.",
    scheduling: { class: "READ_ONLY" },
    inputSchema: runSkillScriptInputSchema,
    resultDetailsSchema: runSkillScriptOutputSchema,
    execute: async (input) => {
      const args = input.args as {
        bindingId: string;
        resourcePath: string;
        args: readonly string[];
        workdir?: string;
        yieldTimeMs?: number;
      };
      await unavailableSkillScriptAdapter({
        runId: input.identity.runId,
        bindingId: args.bindingId,
        resourcePath: args.resourcePath,
        args: args.args,
        ...(args.workdir === undefined ? {} : { workdir: args.workdir }),
        ...(args.yieldTimeMs === undefined ? {} : { yieldTimeMs: args.yieldTimeMs }),
        signal: input.signal,
      });
      return errorResult(
        "SCRIPT_EXECUTION_UNAVAILABLE",
        "Skill script execution is unavailable in this phase.",
      );
    },
  });

  return {
    tool,
    security: {
      riskLevel: "LOW",
      requiredCapabilities: [],
      runtimeRequirements: { runtimeKinds: [] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectRunSkillScriptSecurityFacts),
    promptSnippet: RUN_SKILL_SCRIPT_PROMPT_SNIPPET,
  };
}
