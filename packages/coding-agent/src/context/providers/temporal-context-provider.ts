import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";

import type { ContextClock } from "../ports.js";
import {
  createCodingSourceResult,
  createCodingTextItem,
  resolveCodingTokenEstimator,
  stableJson,
  type CodingContextProviderOptions,
} from "../provider-helpers.js";
import { CODING_CONTEXT_SOURCE_IDS } from "../source-ids.js";

const PROVIDER_VERSION = "temporal-v1";

export interface TemporalContextSourceProviderOptions extends CodingContextProviderOptions {
  readonly clock: ContextClock;
}

export function createTemporalContextSourceProvider(
  options: TemporalContextSourceProviderOptions,
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.temporal,
    async collect(input: ContextSourceInput) {
      const now = options.clock.now();
      if (!Number.isSafeInteger(now)) {
        throw new TypeError("Context clock must return a safe integer timestamp.");
      }
      const utc = new Date(now).toISOString();
      const item = createCodingTextItem({
        id: "coding.temporal:current",
        providerId: CODING_CONTEXT_SOURCE_IDS.temporal,
        sourceRef: "clock:injected",
        version: PROVIDER_VERSION,
        type: "coding.temporal",
        scope: "TURN",
        retention: "EPHEMERAL",
        priorityClass: "NORMAL",
        cacheStability: "DYNAMIC",
        freshness: "CURRENT",
        sensitivity: "INTERNAL",
        whyLoaded: "injected current time anchor",
        text: stableJson({ date: utc.slice(0, 10), timestampMs: now, utc }),
        input,
        tokenEstimator,
      });
      return createCodingSourceResult(CODING_CONTEXT_SOURCE_IDS.temporal, PROVIDER_VERSION, [item]);
    },
  });
}
