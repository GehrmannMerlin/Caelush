import type { AgentExecutionIdentity } from "../../loop/types.js";
import type { ContextFreshness } from "../item/context-item.js";
import { createContextItemId } from "../item/context-item.js";
import type { ContextSourceInput, ContextSourceProvider } from "./context-source.js";
import { createContextSourceItem } from "./context-source-item.js";
import { AGENT_CONTEXT_SOURCE_IDS } from "./source-ids.js";
import { createSourceResult } from "./generic-provider-helpers.js";

const PROVIDER_VERSION = "memory-v1";

export interface ContextMemoryProjection {
  readonly id: string;
  readonly sourceRef: string;
  readonly version: string;
  readonly text: string;
  readonly tokenEstimate: number;
  readonly freshness?: ContextFreshness;
}

export interface ContextMemoryLoader {
  load(input: {
    readonly identity: AgentExecutionIdentity;
    readonly signal: AbortSignal;
  }): Promise<readonly ContextMemoryProjection[]>;
}

export interface MemoryContextSourceProviderOptions {
  readonly loader?: ContextMemoryLoader;
}

export function createMemoryContextSourceProvider(
  options: MemoryContextSourceProviderOptions = {},
): ContextSourceProvider {
  return Object.freeze({
    id: AGENT_CONTEXT_SOURCE_IDS.memory,
    async collect(input: ContextSourceInput) {
      const projections =
        (await options.loader?.load({
          identity: input.identity,
          signal: input.signal,
        })) ?? [];
      const items = projections.map((projection) =>
        createContextSourceItem({
          id: createContextItemId(`agent.memory:${projection.id}`),
          type: "agent.memory",
          source: {
            providerId: AGENT_CONTEXT_SOURCE_IDS.memory,
            sourceRef: projection.sourceRef,
            version: projection.version,
          },
          scope: "SESSION",
          retention: "RETRIEVABLE",
          priorityClass: "LOW",
          tokenEstimate: projection.tokenEstimate,
          cacheStability: "SEMI_STABLE",
          freshness: projection.freshness ?? "CURRENT",
          sensitivity: "INTERNAL",
          whyLoaded: "safe memory projection",
          payload: { kind: "TEXT", text: projection.text },
        }),
      );
      return createSourceResult(AGENT_CONTEXT_SOURCE_IDS.memory, PROVIDER_VERSION, items);
    },
  });
}
