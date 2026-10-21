import {
  createContextItemId,
  createContextSourceId,
  createContextSourceItem,
  type ContextSourceInput,
  type ContextSourceProvider,
} from "@caelush/agent";
import type { CaelushStorage } from "@caelush/storage";
import {
  RESOURCE_GOVERNANCE_CORRECTION_PROVIDER_ID,
  RESOURCE_GOVERNANCE_CORRECTION_PROVIDER_VERSION,
  resourceGovernanceCorrectionContextItemId,
} from "@caelush/core";
import { projectModelResourceGovernance } from "./resource-governance-context.js";

const SOURCE_ID = createContextSourceId(RESOURCE_GOVERNANCE_CORRECTION_PROVIDER_ID);
const SOURCE_VERSION = RESOURCE_GOVERNANCE_CORRECTION_PROVIDER_VERSION;

/** Carry only pending correction advice through a selectable, receipt-backed Context source. */
export function createResourceGovernanceContextProvider(input: {
  readonly storage: Pick<CaelushStorage, "resourceGovernance">;
}): ContextSourceProvider {
  return Object.freeze({
    id: SOURCE_ID,
    async collect(context: ContextSourceInput) {
      const state = await input.storage.resourceGovernance.get(context.identity.runId);
      const correction = state?.semanticProgress?.correction;
      if (state === null || state === undefined || correction === undefined) {
        return {
          providerId: SOURCE_ID,
          providerVersion: SOURCE_VERSION,
          items: [],
          diagnostics: [],
        };
      }

      const itemId = createContextItemId(
        resourceGovernanceCorrectionContextItemId(correction.interventionId),
      );
      const text = projectModelResourceGovernance(state);
      return {
        providerId: SOURCE_ID,
        providerVersion: SOURCE_VERSION,
        items: [
          createContextSourceItem({
            id: itemId,
            type: "coding.runtime_fact",
            source: {
              providerId: SOURCE_ID,
              sourceRef: `resource-correction:${correction.interventionId}`,
              version: SOURCE_VERSION,
            },
            scope: "RUN",
            retention: "EPHEMERAL",
            priorityClass: "HIGH",
            tokenEstimate: estimateTokens(text),
            cacheStability: "DYNAMIC",
            freshness: "CURRENT",
            sensitivity: "INTERNAL",
            whyLoaded: `pending correction ${correction.interventionId}`,
            payload: { kind: "TEXT", text },
          }),
        ],
        diagnostics: [],
      };
    },
  });
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}
