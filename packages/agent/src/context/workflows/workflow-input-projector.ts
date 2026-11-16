import {
  PreparedWorkflowResourceRefV1Schema,
  WorkflowResourceBindingV1Schema,
  type PreparedWorkflowResourceRefV1,
  type RunId,
  type WorkflowResourceBindingV1,
} from "@caelush/protocol";

import type { ModelDescriptor } from "@caelush/ai";

import { createContextItem, createContextItemId, createContextSourceId } from "../item/context-item.js";
import { createSourceResult } from "../source/generic-provider-helpers.js";
import type { ContextSourceResult } from "../source/context-source.js";
import { safeContextText } from "../source/safe-context-text.js";
import { renderWorkflowInstructionFragment, WORKFLOW_INSTRUCTION_RENDERER_VERSION } from "./workflow-instruction-renderer.js";
import {
  MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS,
  MAX_WORKFLOW_INSTRUCTION_BYTES,
  WORKFLOW_INSTRUCTION_PROVIDER_VERSION,
  WORKFLOW_INSTRUCTION_SOURCE_ID,
  type ActiveWorkflowResource,
  type PreparedWorkflowProjection,
  type WorkflowInstructionFragmentV1,
} from "./workflow-instruction.js";

export interface WorkflowInputProjectorOptions {
  readonly estimateTokens?: (text: string, model: ModelDescriptor) => number;
  readonly rendererVersion?: string;
}

export interface WorkflowInputProjector {
  project(input: {
    readonly runId: RunId;
    readonly resources: readonly ActiveWorkflowResource[];
    readonly model: ModelDescriptor;
    readonly effectiveInputLimitTokens: number;
  }): PreparedWorkflowProjection;
}

export function createWorkflowInputProjector(
  options: WorkflowInputProjectorOptions = {},
): WorkflowInputProjector {
  return Object.freeze({
    project(input: Parameters<WorkflowInputProjector["project"]>[0]) {
      const totalTokenBudget = Math.max(
        1,
        Math.min(
          MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS,
          Math.floor(input.effectiveInputLimitTokens * 0.1),
        ),
      );
      const bindings = new Set<string>();
      const resources: PreparedWorkflowResourceRefV1[] = [];
      const fragments: WorkflowInstructionFragmentV1[] = [];
      let totalTokens = 0;
      for (const candidate of input.resources) {
        const binding = WorkflowResourceBindingV1Schema.parse(candidate.binding);
        if (binding.runId !== input.runId || binding.resourceKind !== "WORKFLOW_INSTRUCTION") {
          throw new TypeError("Active workflow resource is bound to a different Run.");
        }
        if (bindings.has(binding.bindingId)) {
          throw new TypeError("Active workflow resources contain a duplicate binding.");
        }
        bindings.add(binding.bindingId);
        const sourceBytes = Buffer.byteLength(candidate.body, "utf8");
        if (sourceBytes > MAX_WORKFLOW_INSTRUCTION_BYTES) {
          throw new RangeError("A workflow instruction exceeds the 64 KiB core limit.");
        }
        if (binding.utf8Bytes !== sourceBytes) {
          throw new TypeError("Workflow instruction body does not match its Run-bound artifact.");
        }
        const safeBody = safeContextText(candidate.body);
        const rendered = renderWorkflowInstructionFragment({
          binding,
          body: safeBody,
          ...(options.rendererVersion === undefined ? {} : { rendererVersion: options.rendererVersion }),
        });
        const tokenEstimate = Math.max(
          1,
          options.estimateTokens?.(rendered.text, input.model) ??
            Math.ceil(Buffer.byteLength(rendered.text, "utf8") / 3),
        );
        if (totalTokens > totalTokenBudget - tokenEstimate) {
          throw new RangeError("Active workflow instructions exceed their independent token budget.");
        }
        totalTokens += tokenEstimate;
        resources.push(
          PreparedWorkflowResourceRefV1Schema.parse({
            bindingId: binding.bindingId,
            artifactRef: binding.artifactRef,
            projectionFingerprint: rendered.projectionFingerprint,
            rendererVersion: options.rendererVersion ?? WORKFLOW_INSTRUCTION_RENDERER_VERSION,
            utf8Bytes: rendered.utf8Bytes,
            tokenEstimate,
          }),
        );
        fragments.push(
          Object.freeze({
            bindingId: binding.bindingId,
            projectionFingerprint: rendered.projectionFingerprint,
            rendererVersion: options.rendererVersion ?? WORKFLOW_INSTRUCTION_RENDERER_VERSION,
            text: rendered.text,
          }),
        );
      }
      return Object.freeze({
        resources: Object.freeze(resources),
        fragments: Object.freeze(fragments),
      });
    },
  });
}

export function createWorkflowInstructionContextSourceResult(
  projection: PreparedWorkflowProjection,
): ContextSourceResult & { readonly preparedWorkflowProjection: PreparedWorkflowProjection } {
  const providerId = createContextSourceId(WORKFLOW_INSTRUCTION_SOURCE_ID);
  const items = projection.fragments.map((fragment) => {
    const resource = projection.resources.find(({ bindingId }) => bindingId === fragment.bindingId);
    if (resource === undefined) throw new TypeError("Workflow projection has no matching resource ref.");
    return createContextItem({
      id: createContextItemId(`agent.workflow-instruction:${fragment.bindingId}`),
      type: "agent.workflow-instruction",
      source: { providerId, sourceRef: resource.artifactRef, version: fragment.rendererVersion },
      scope: "RUN",
      retention: "PINNED",
      priorityClass: "CRITICAL",
      tokenEstimate: resource.tokenEstimate,
      cacheStability: "DYNAMIC",
      freshness: "CURRENT",
      sensitivity: "INTERNAL",
      whyLoaded: "active workflow instruction required for this Run",
      payload: { kind: "TEXT", text: fragment.text },
    });
  });
  const base = createSourceResult(providerId, WORKFLOW_INSTRUCTION_PROVIDER_VERSION, items);
  return Object.freeze({ ...base, preparedWorkflowProjection: projection });
}

export type { WorkflowResourceBindingV1 };
