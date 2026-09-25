import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";

import { CODING_CONTEXT_SOURCE_IDS } from "../source-ids.js";
import type { CodingWorkspacePort } from "../ports.js";
import {
  createCodingSourceResult,
  createCodingTextItem,
  resolveCodingTokenEstimator,
  stableJson,
  type CodingContextProviderOptions,
} from "../provider-helpers.js";

const PROVIDER_VERSION = "workspace-v1";

export interface WorkspaceContextSourceProviderOptions extends CodingContextProviderOptions {
  readonly port: CodingWorkspacePort;
}

export function createWorkspaceContextSourceProvider(
  options: WorkspaceContextSourceProviderOptions,
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.workspace,
    async collect(input: ContextSourceInput) {
      const descriptor = await options.port.describe({
        identity: input.identity,
        signal: input.signal,
      });
      const text = stableJson({
        workspaceId: descriptor.workspaceId,
        projectId: descriptor.projectId,
        workspaceRef: descriptor.workspaceRef,
        projectRef: descriptor.projectRef,
        cwdRef: descriptor.cwdRef,
        runtimeKind: descriptor.runtimeKind,
        safeMetadata: descriptor.safeMetadata,
      });
      const item = createCodingTextItem({
        id: `coding.workspace:${descriptor.workspaceId}:${descriptor.projectId}`,
        providerId: CODING_CONTEXT_SOURCE_IDS.workspace,
        sourceRef: `${descriptor.workspaceRef}/${descriptor.projectRef}`,
        version: PROVIDER_VERSION,
        type: "coding.workspace",
        scope: "PROJECT",
        retention: "REHYDRATABLE",
        priorityClass: "HIGH",
        cacheStability: "SEMI_STABLE",
        freshness: "CURRENT",
        sensitivity: "INTERNAL",
        whyLoaded: "safe workspace identity and runtime metadata",
        text,
        input,
        tokenEstimator,
      });
      return createCodingSourceResult(CODING_CONTEXT_SOURCE_IDS.workspace, PROVIDER_VERSION, [
        item,
      ]);
    },
  });
}
