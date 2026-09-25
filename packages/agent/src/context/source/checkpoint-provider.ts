import type { AgentExecutionIdentity } from "../../loop/types.js";
import type {
  ContextItem,
  StructuredCheckpoint,
} from "../item/context-item.js";
import { createContextItemId } from "../item/context-item.js";
import type { ContextSourceInput, ContextSourceProvider } from "./context-source.js";
import { createContextSourceItem } from "./context-source-item.js";
import { AGENT_CONTEXT_SOURCE_IDS } from "./source-ids.js";
import { createSourceResult, estimateContextTokens } from "./generic-provider-helpers.js";

const PROVIDER_VERSION = "checkpoint-v1";

export interface ContextCheckpointProjection {
  readonly checkpointId: string;
  readonly sourceRef: string;
  readonly version: string;
  readonly checkpoint: StructuredCheckpoint;
}

export interface ContextCheckpointLoader {
  load(input: {
    readonly identity: AgentExecutionIdentity;
    readonly signal: AbortSignal;
  }): Promise<ContextCheckpointProjection | undefined>;
}

export interface CheckpointContextSourceProviderOptions {
  readonly loader?: ContextCheckpointLoader;
}

export function createCheckpointContextSourceProvider(
  options: CheckpointContextSourceProviderOptions = {},
): ContextSourceProvider {
  return Object.freeze({
    id: AGENT_CONTEXT_SOURCE_IDS.checkpoint,
    async collect(input: ContextSourceInput) {
      const projection = await options.loader?.load({
        identity: input.identity,
        signal: input.signal,
      });
      if (projection === undefined) {
        return createSourceResult(AGENT_CONTEXT_SOURCE_IDS.checkpoint, PROVIDER_VERSION, []);
      }
      const item: ContextItem = createContextSourceItem({
        id: createContextItemId(`agent.checkpoint:${projection.checkpointId}`),
        type: "agent.checkpoint",
        source: {
          providerId: AGENT_CONTEXT_SOURCE_IDS.checkpoint,
          sourceRef: projection.sourceRef,
          version: projection.version,
        },
        scope: "RUN",
        retention: "REHYDRATABLE",
        priorityClass: "HIGH",
        tokenEstimate: estimateContextTokens(projection.checkpoint),
        cacheStability: "STABLE",
        freshness: "CURRENT",
        sensitivity: "INTERNAL",
        whyLoaded: "durable checkpoint snapshot",
        payload: { kind: "CHECKPOINT", checkpoint: projection.checkpoint },
      });
      return createSourceResult(AGENT_CONTEXT_SOURCE_IDS.checkpoint, PROVIDER_VERSION, [item]);
    },
  });
}
