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
const MAX_ITEM_BYTES = 16 * 1024;
const MAX_SOURCE_BYTES = 512;
const MAX_WHY_LOADED_BYTES = 2 * 1024;
const HOST_PATH =
  /(?:[A-Za-z]:[\\/]{1,2}|\\\\[^\s\\/]+[\\/]|\/(?:Users|home|root|var|etc|opt|tmp)\/)/;

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
        contribution.items.map((contributionItem) => {
          const source = boundedSafeText(contribution.source, MAX_SOURCE_BYTES);
          const contributionId = boundedSafeText(contribution.id, MAX_SOURCE_BYTES);
          const itemId = boundedSafeText(contributionItem.id, MAX_SOURCE_BYTES);
          const content = boundedSafeText(contributionItem.content, MAX_ITEM_BYTES);
          const whyLoaded = boundedSafeText(
            contributionItem.whyLoaded ?? `validated extension contribution from ${source}`,
            MAX_WHY_LOADED_BYTES,
          );
          return createContextSourceItem({
            id: createContextItemId(`agent.extension-contributions:${contributionId}:${itemId}`),
            type: "agent.extension-contribution",
            source: {
              providerId: AGENT_CONTEXT_SOURCE_IDS.extensionContributions,
              sourceRef: `${source}/${contributionId}/${itemId}`,
              version: PROVIDER_VERSION,
            },
            scope: "TURN",
            retention: "EPHEMERAL",
            priorityClass: mapLegacyPriority(contributionItem.priorityClass),
            tokenEstimate: estimateContextTokens(content),
            cacheStability: "DYNAMIC",
            freshness: "CURRENT",
            sensitivity: "INTERNAL",
            whyLoaded,
            payload: { kind: "TEXT", text: content },
          });
        }),
      );
      return createSourceResult(
        AGENT_CONTEXT_SOURCE_IDS.extensionContributions,
        PROVIDER_VERSION,
        items,
      );
    },
  });
}

function boundedSafeText(value: string, maxBytes: number): string {
  const safe = safeContributionText(value);
  if (new TextEncoder().encode(safe).byteLength <= maxBytes) return safe;
  let output = "";
  for (const character of safe) {
    const candidate = output + character;
    if (new TextEncoder().encode(candidate).byteLength > maxBytes) break;
    output = candidate;
  }
  return output;
}

function safeContributionText(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
  return HOST_PATH.test(redacted) ? "[REDACTED:HOST_PATH]" : redacted;
}
