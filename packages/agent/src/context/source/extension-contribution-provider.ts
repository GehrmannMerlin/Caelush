import type { ContextContribution } from "../../hooks/context-contribution.js";
import type { AgentExecutionIdentity, AgentTurnRef } from "../../loop/types.js";
import type { ContextPrepareMode } from "../../loop/context/context-engine-port.js";
import type { ContextSourceInput, ContextSourceProvider } from "./context-source.js";
import { createContextItemId } from "../item/context-item.js";
import { createContextSourceItem } from "./context-source-item.js";
import { AGENT_CONTEXT_SOURCE_IDS } from "./source-ids.js";
import {
  createSourceResult,
  estimateContextTokens,
  mapLegacyPriority,
} from "./generic-provider-helpers.js";

const PROVIDER_VERSION = "extension-contributions-v1";

export interface ContextContributionLoader {
  load(input: {
    readonly identity: AgentExecutionIdentity;
    readonly turn: AgentTurnRef;
    readonly mode: ContextPrepareMode;
    readonly signal: AbortSignal;
  }): Promise<readonly ContextContribution[]>;
}

export interface ExtensionContributionContextSourceProviderOptions {
  readonly loader?: ContextContributionLoader;
}

export function createExtensionContributionContextSourceProvider(
  options: ExtensionContributionContextSourceProviderOptions = {},
): ContextSourceProvider {
  return Object.freeze({
    id: AGENT_CONTEXT_SOURCE_IDS.extensionContributions,
    async collect(input: ContextSourceInput) {
      const contributions =
        (await options.loader?.load({
          identity: input.identity,
          turn: input.turn,
          mode: input.mode,
          signal: input.signal,
        })) ?? [];
      const items = contributions.flatMap((contribution) =>
        contribution.items.map((contributionItem) =>
          createContextSourceItem({
            id: createContextItemId(
              `agent.extension-contributions:${contribution.id}:${contributionItem.id}`,
            ),
            type: "agent.extension-contribution",
            source: {
              providerId: AGENT_CONTEXT_SOURCE_IDS.extensionContributions,
              sourceRef: `${contribution.source}/${contribution.id}/${contributionItem.id}`,
              version: PROVIDER_VERSION,
            },
            scope: "TURN",
            retention: "EPHEMERAL",
            priorityClass: mapLegacyPriority(contributionItem.priorityClass),
            tokenEstimate:
              contributionItem.tokenEstimate ?? estimateContextTokens(contributionItem.content),
            cacheStability: "DYNAMIC",
            freshness: "CURRENT",
            sensitivity: "INTERNAL",
            whyLoaded: contributionItem.whyLoaded ?? "validated extension contribution",
            payload: { kind: "TEXT", text: contributionItem.content },
          }),
        ),
      );
      return createSourceResult(
        AGENT_CONTEXT_SOURCE_IDS.extensionContributions,
        PROVIDER_VERSION,
        items,
      );
    },
  });
}
