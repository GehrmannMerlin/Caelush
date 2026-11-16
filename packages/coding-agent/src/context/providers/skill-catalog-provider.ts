import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";
import {
  buildCatalogPresentation,
  resolveSkillCatalogTokenBudget,
  type SkillSearchCatalog,
} from "@caelush/skills";

import type { SkillCatalogPort } from "../ports.js";
import {
  createCodingSourceResult,
  createCodingTextItem,
  resolveCodingTokenEstimator,
  type CodingContextProviderOptions,
} from "../provider-helpers.js";
import { CODING_CONTEXT_SOURCE_IDS } from "../source-ids.js";

const PROVIDER_VERSION = "skill-catalog-v2";

export interface SkillCatalogContextSourceProviderOptions extends CodingContextProviderOptions {
  readonly port?: SkillCatalogPort;
}

export function createNoOpSkillCatalogPort(): SkillCatalogPort {
  return Object.freeze({
    async list() {
      return EMPTY_CATALOG;
    },
  });
}

const EMPTY_CATALOG: SkillSearchCatalog = Object.freeze({
  revision: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  entries: Object.freeze([]),
  diagnostics: Object.freeze([]),
  complete: true,
});

export function createSkillCatalogContextSourceProvider(
  options: SkillCatalogContextSourceProviderOptions = {},
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  const port = options.port ?? createNoOpSkillCatalogPort();
  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.skillCatalog,
    async collect(input: ContextSourceInput) {
      const catalog = await port.list({
        runId: input.identity.runId,
        signal: input.signal,
      });
      const presentation = buildCatalogPresentation({
        catalog,
        maxTokens: resolveSkillCatalogTokenBudget(input.policy.effectiveInputLimitTokens),
        estimate: (text) => tokenEstimator.estimateText(text, input.model),
      });
      const items =
        presentation.text.length === 0
          ? []
          : [
              createCodingTextItem({
                id: "coding.skill-catalog:model",
                providerId: CODING_CONTEXT_SOURCE_IDS.skillCatalog,
                sourceRef: `skill-catalog:${presentation.presentationHash}`,
                version: presentation.presentationHash,
                type: "coding.skill_catalog",
                scope: "PROJECT",
                retention: "RETRIEVABLE",
                priorityClass: "LOW",
                cacheStability: "STABLE",
                freshness: "CURRENT",
                sensitivity: "INTERNAL",
                whyLoaded: "bounded Run-bound Skill discovery metadata",
                text: presentation.text,
                input,
                tokenEstimator,
              }),
            ];
      return createCodingSourceResult(
        CODING_CONTEXT_SOURCE_IDS.skillCatalog,
        PROVIDER_VERSION,
        items,
      );
    },
  });
}
