import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";

import type { CodingRuntimeFactsPort } from "../ports.js";
import {
  assertBoundedText,
  createCodingSourceResult,
  createCodingTextItem,
  resolveCodingTokenEstimator,
  type CodingContextProviderOptions,
} from "../provider-helpers.js";
import { CODING_CONTEXT_SOURCE_IDS } from "../source-ids.js";

const PROVIDER_VERSION = "runtime-facts-v1";
const MAX_FACTS = 64;
const MAX_FACT_BYTES = 4 * 1024;

export interface RuntimeFactsContextSourceProviderOptions extends CodingContextProviderOptions {
  readonly port: CodingRuntimeFactsPort;
}

export function createRuntimeFactsContextSourceProvider(
  options: RuntimeFactsContextSourceProviderOptions,
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.runtimeFacts,
    async collect(input: ContextSourceInput) {
      const projection = await options.port.read({
        identity: input.identity,
        signal: input.signal,
      });
      if (projection.facts.length > MAX_FACTS) {
        throw new TypeError("Runtime facts exceed their bounded count contract.");
      }
      const items = projection.facts.map((fact, index) => {
        assertBoundedText(fact, MAX_FACT_BYTES, "Runtime fact");
        return createCodingTextItem({
          id: `coding.runtime-facts:${projection.sourceRef}:${index}`,
          providerId: CODING_CONTEXT_SOURCE_IDS.runtimeFacts,
          sourceRef: `${projection.sourceRef}/fact/${index}`,
          version: projection.version,
          type: "coding.runtime_fact",
          scope: "RUN",
          retention: "RECENT",
          priorityClass: "HIGH",
          cacheStability: "DYNAMIC",
          freshness: "CURRENT",
          sensitivity: "INTERNAL",
          whyLoaded: "bounded safe runtime fact",
          text: fact,
          input,
          tokenEstimator,
        });
      });
      return createCodingSourceResult(
        CODING_CONTEXT_SOURCE_IDS.runtimeFacts,
        PROVIDER_VERSION,
        items,
      );
    },
  });
}
