import type { ToolDefinition } from "@caelush/protocol";
import { RuntimePatchUncertainError, type RuntimeResolver } from "@caelush/runtime";
import { ToolExecutionUncertainError } from "../errors.js";
import type { ToolExecutionRequest, ToolHandler } from "../handler.js";
import type { ToolRegistration } from "../registration.js";
import { projectPatchEffects } from "../tool-effects.js";
import { projectApplyPatchSecurityFacts } from "./security-facts.js";
import { errorResult, successResult, withRuntimeScope } from "./result.js";
import { createBuiltinToolModelGuidance } from "../model-guidance.js";

const definition: ToolDefinition = {
  name: "apply_patch",
  description: "Apply workspace patch.",
  inputSchema: {
    type: "object",
    properties: {
      patch: { type: "string", minLength: 1, description: "The complete patch document." },
    },
    required: ["patch"],
    additionalProperties: false,
  },
  outputSchema: {
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
  },
  riskLevel: "HIGH",
  requiredCapabilities: ["FS_WRITE", "FS_DELETE"],
  runtimeRequirements: { runtimeKinds: ["local"] },
};

export function createApplyPatchRegistration(runtimeResolver: RuntimeResolver): ToolRegistration {
  const handler: ToolHandler = {
    execute: async (request) => executeApplyPatch(request, runtimeResolver),
  };
  return {
    definition,
    handler,
    effectProjector: projectPatchEffects,
    securityFactsProjector: projectApplyPatchSecurityFacts,
    modelGuidance: createBuiltinToolModelGuidance("apply_patch"),
  };
}

async function executeApplyPatch(request: ToolExecutionRequest, resolver: RuntimeResolver) {
  const patch = request.args.patch;
  if (typeof patch !== "string" || patch.length === 0) {
    return errorResult("INVALID_PATCH", "Tool operation failed: INVALID_PATCH.");
  }
  return withRuntimeScope(request, resolver, async (scope) => {
    try {
      const result = await scope.patch.apply({
        patch,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return successResult("Patch applied.", {
        changeCount: result.changeCount,
        changes: result.changes.map((change) => ({ ...change })),
      });
    } catch (error) {
      if (error instanceof RuntimePatchUncertainError) throw new ToolExecutionUncertainError();
      throw error;
    }
  });
}
