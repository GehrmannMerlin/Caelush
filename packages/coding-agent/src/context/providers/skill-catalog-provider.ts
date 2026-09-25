import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";

import type { SkillCatalogPort } from "../ports.js";
import {
  assertBoundedText,
  assertSafeOpaqueReference,
  createCodingSourceResult,
  createCodingTextItem,
  resolveCodingTokenEstimator,
  stableJson,
  type CodingContextProviderOptions,
} from "../provider-helpers.js";
import { CODING_CONTEXT_SOURCE_IDS } from "../source-ids.js";

const PROVIDER_VERSION = "skill-catalog-v1";
const MAX_SKILLS = 64;
const MAX_SKILL_NAME_BYTES = 512;
const MAX_SKILL_DESCRIPTION_BYTES = 4 * 1024;

export interface SkillCatalogContextSourceProviderOptions extends CodingContextProviderOptions {
  readonly port?: SkillCatalogPort;
  readonly projectId?: string;
}

export function createNoOpSkillCatalogPort(): SkillCatalogPort {
  return Object.freeze({
    async list() {
      return [];
    },
  });
}

export function createSkillCatalogContextSourceProvider(
  options: SkillCatalogContextSourceProviderOptions = {},
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  const port = options.port ?? createNoOpSkillCatalogPort();
  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.skillCatalog,
    async collect(input: ContextSourceInput) {
      const entries = await port.list({
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        signal: input.signal,
      });
      if (entries.length > MAX_SKILLS) {
        throw new TypeError("Skill catalog exceeds its bounded entry count.");
      }
      const items = entries.map((entry) => {
        assertBoundedText(entry.name, MAX_SKILL_NAME_BYTES, "Skill name");
        assertBoundedText(entry.description, MAX_SKILL_DESCRIPTION_BYTES, "Skill description");
        assertSafeOpaqueReference(entry.resourceRef, "Skill resourceRef");
        assertBoundedText(entry.version, MAX_SKILL_NAME_BYTES, "Skill version");
        return createCodingTextItem({
          id: `coding.skill-catalog:${entry.name}:${entry.version}`,
          providerId: CODING_CONTEXT_SOURCE_IDS.skillCatalog,
          sourceRef: entry.resourceRef,
          version: entry.version,
          type: "coding.skill_catalog",
          scope: "PROJECT",
          retention: "RETRIEVABLE",
          priorityClass: "LOW",
          cacheStability: "STABLE",
          freshness: "CURRENT",
          sensitivity: "INTERNAL",
          whyLoaded: "skill catalog metadata reference",
          text: stableJson({
            name: entry.name,
            description: entry.description,
            resourceRef: entry.resourceRef,
            version: entry.version,
          }),
          input,
          tokenEstimator,
        });
      });
      return createCodingSourceResult(
        CODING_CONTEXT_SOURCE_IDS.skillCatalog,
        PROVIDER_VERSION,
        items,
      );
    },
  });
}
