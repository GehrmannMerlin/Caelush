import { RuntimeInvariantError, RuntimePatchUncertainError } from "@caelush/runtime";

import { ToolExecutionUncertainError } from "@caelush/agent";
import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { PatchOperations } from "../operations/operations.js";
import { projectPatchEffects } from "../effects/effect-projectors.js";
import { projectApplyPatchSecurityFacts } from "../security/security-facts.js";
import { APPLY_PATCH_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { defineCodingTool } from "./define-coding-tool.js";
import {
  errorResult,
  runtimeErrorToResult,
  successResult,
  asOverlaySecurityFactsProjector,
  asOverlayEffectProjector,
  type AgentToolResult,
} from "./result.js";

/**
 * `apply_patch` — apply one verified patch document.
 *
 * ## The uncertain boundary is the whole reason this Tool is careful
 *
 * A patch can fail in a way that no one can resolve: the commit may have partially applied, or the
 * rollback may itself have failed. The Runtime signals exactly that case with
 * `RuntimePatchUncertainError`, and this Tool converts it into the **canonical** uncertain-side-effect
 * signal — `ToolExecutionUncertainError` from `@caelush/agent`, whose vocabulary the executor already
 * understands.
 *
 * ```text
 * RuntimePatchUncertainError
 *   → Coding Tool boundary (here)
 *   → canonical uncertain signal
 *   → ToolInvocationExecutor
 *   → FAILED + UNCERTAIN_SIDE_EFFECT
 *   → ToolBatchCoordinator
 *   → remaining calls skipped
 * ```
 *
 * That chain is why the error must not be caught as an ordinary failure. A model told "the patch
 * failed" would patch again, and the second patch would apply on top of a workspace whose state nobody
 * has observed.
 *
 * The uncertain vocabulary is imported from `@caelush/agent` rather than from the legacy Tool package:
 * the canonical class is what the executor recognizes, and a second declaration would make `instanceof`
 * disagree at the exact boundary that decides whether trailing calls run.
 *
 * ## Behaviour is unchanged
 *
 * Same name, description, input schema, details shape and failure codes.
 */
const inputSchema = {
  type: "object",
  properties: {
    patch: { type: "string", minLength: 1, description: "The complete patch document." },
  },
  required: ["patch"],
  additionalProperties: false,
} as const;

const resultDetailsSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    changeCount: { type: "integer", minimum: 0 },
    changes: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["ADD", "UPDATE", "DELETE", "MOVE"] },
          path: { type: "string" },
          fromPath: { type: "string" },
          toPath: { type: "string" },
          additions: { type: "integer", minimum: 0 },
          deletions: { type: "integer", minimum: 0 },
          beforeHash: { type: "string" },
          afterHash: { type: "string" },
        },
        required: ["kind", "path", "additions", "deletions"],
        additionalProperties: false,
      },
    },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

export function createApplyPatchTool(operations: PatchOperations): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "apply_patch",
    description: "Apply workspace patch.",
    inputSchema,
    resultDetailsSchema,
    execute: async (input): Promise<AgentToolResult> => {
      const patch = input.args.patch;
      if (typeof patch !== "string" || patch.length === 0) {
        return errorResult("INVALID_PATCH", "Tool operation failed: INVALID_PATCH.");
      }

      try {
        const result = await operations.apply({
          environment: input.environment,
          patch,
          signal: input.signal,
        });
        return successResult("Patch applied.", {
          changeCount: result.changeCount,
          changes: result.changes.map((change) => ({ ...change })),
        });
      } catch (error) {
        // The one case that must never become an ordinary failure.
        if (error instanceof RuntimePatchUncertainError) throw new ToolExecutionUncertainError();
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
      riskLevel: "HIGH",
      requiredCapabilities: ["FS_WRITE", "FS_DELETE"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectApplyPatchSecurityFacts),
    effectProjector: asOverlayEffectProjector(projectPatchEffects),
    promptSnippet: APPLY_PATCH_PROMPT_SNIPPET,
  };
}

export { inputSchema as applyPatchInputSchema };
