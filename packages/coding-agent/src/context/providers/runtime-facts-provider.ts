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

const PROVIDER_VERSION = "runtime-facts-v2";
const MAX_FACTS = 64;
const MAX_FACT_BYTES = 4 * 1024;
const RUNTIME_FACT_KEY_PATTERN = /^[a-z][A-Za-z0-9._-]{0,63}$/;

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
      const keyedFacts = new Map<string, string>();
      const unkeyedFacts = new Set<string>();
      for (const fact of projection.facts) {
        if (typeof fact === "string") {
          assertBoundedText(fact, MAX_FACT_BYTES, "Runtime fact");
          unkeyedFacts.add(fact);
          continue;
        }
        if (
          fact === null ||
          typeof fact !== "object" ||
          typeof fact.key !== "string" ||
          !RUNTIME_FACT_KEY_PATTERN.test(fact.key) ||
          typeof fact.value !== "string"
        ) {
          throw new TypeError("Runtime fact semantic key or value is invalid.");
        }
        assertBoundedText(fact.value, MAX_FACT_BYTES, "Runtime fact value");
        const existing = keyedFacts.get(fact.key);
        if (existing !== undefined && existing !== fact.value) {
          throw new TypeError("Runtime fact semantic key has conflicting values.");
        }
        keyedFacts.set(fact.key, fact.value);
      }

      const items = [
        ...[...keyedFacts.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, value]) =>
            createCodingTextItem({
              id: `coding.runtime-facts:${key}`,
              providerId: CODING_CONTEXT_SOURCE_IDS.runtimeFacts,
              sourceRef: `${projection.sourceRef}/fact/${key}`,
              version: projection.version,
              type: "coding.runtime_fact",
              scope: "RUN",
              retention: "RECENT",
              priorityClass: "HIGH",
              cacheStability: "DYNAMIC",
              freshness: "CURRENT",
              sensitivity: "INTERNAL",
              whyLoaded: "bounded safe runtime fact",
              text: JSON.stringify({ [key]: value }),
              input,
              tokenEstimator,
            }),
          ),
        ...(unkeyedFacts.size === 0
          ? []
          : [
              createCodingTextItem({
                id: "coding.runtime-facts:unkeyed",
                providerId: CODING_CONTEXT_SOURCE_IDS.runtimeFacts,
                sourceRef: `${projection.sourceRef}/unkeyed-facts`,
                version: projection.version,
                type: "coding.runtime_fact",
                scope: "RUN",
                retention: "RECENT",
                priorityClass: "HIGH",
                cacheStability: "DYNAMIC",
                freshness: "CURRENT",
                sensitivity: "INTERNAL",
                whyLoaded: "bounded legacy runtime facts without individual semantic keys",
                text: JSON.stringify([...unkeyedFacts].sort()),
                input,
                tokenEstimator,
              }),
            ]),
      ];
      return createCodingSourceResult(
        CODING_CONTEXT_SOURCE_IDS.runtimeFacts,
        PROVIDER_VERSION,
        items,
      );
    },
  });
}
