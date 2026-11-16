import { WorkflowResourceBindingV1Schema } from "@caelush/protocol";

import type { ContextSourceInput, ContextSourceProvider } from "../source/context-source.js";
import { createSourceResult } from "../source/generic-provider-helpers.js";
import { createContextSourceId } from "../item/context-item.js";
import {
  createWorkflowInputProjector,
  createWorkflowInstructionContextSourceResult,
} from "./workflow-input-projector.js";
import {
  WORKFLOW_INSTRUCTION_PROVIDER_VERSION,
  WORKFLOW_INSTRUCTION_SOURCE_ID,
  type ActiveWorkflowResourceReader,
} from "./workflow-instruction.js";
import { WORKFLOW_INSTRUCTION_RENDERER_VERSION } from "./workflow-instruction-renderer.js";

export interface WorkflowInstructionContextSourceProviderOptions {
  readonly reader: ActiveWorkflowResourceReader;
  readonly estimateTokens?: (text: string, model: ContextSourceInput["model"]) => number;
}

export function createWorkflowInstructionContextSourceProvider(
  options: WorkflowInstructionContextSourceProviderOptions,
): ContextSourceProvider {
  const id = createContextSourceId(WORKFLOW_INSTRUCTION_SOURCE_ID);
  const projector = createWorkflowInputProjector({
    ...(options.estimateTokens === undefined ? {} : { estimateTokens: options.estimateTokens }),
  });
  return Object.freeze({
    id,
    async collect(input: Parameters<ContextSourceProvider["collect"]>[0]) {
      const resources = await options.reader.load({
        runId: input.identity.runId,
        signal: input.signal,
      });
      if (resources.length === 0)
        return createSourceResult(id, WORKFLOW_INSTRUCTION_PROVIDER_VERSION, []);
      const versions = new Set(resources.map(({ rendererVersion }) => rendererVersion));
      if (versions.size !== 1 || !versions.has(WORKFLOW_INSTRUCTION_RENDERER_VERSION)) {
        throw new TypeError("Active workflow renderer version is unsupported.");
      }
      for (const resource of resources) {
        const binding = WorkflowResourceBindingV1Schema.parse(resource.binding);
        if (binding.runId !== input.identity.runId) {
          throw new TypeError("Active workflow resource is bound to another Run.");
        }
      }
      const projection = projector.project({
        runId: input.identity.runId,
        resources,
        model: input.model,
        effectiveInputLimitTokens: input.policy.effectiveInputLimitTokens,
      });
      return createWorkflowInstructionContextSourceResult(projection);
    },
  });
}
