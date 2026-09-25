import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";

import type { ProjectMetadataContextPort } from "../ports.js";
import {
  assertBoundedText,
  createCodingSourceResult,
  createCodingTextItem,
  resolveCodingTokenEstimator,
  stableJson,
  type CodingContextProviderOptions,
} from "../provider-helpers.js";
import { CODING_CONTEXT_SOURCE_IDS } from "../source-ids.js";

const PROVIDER_VERSION = "project-metadata-v1";
const MAX_METADATA_BYTES = 32 * 1024;

export interface ProjectMetadataContextSourceProviderOptions extends CodingContextProviderOptions {
  readonly port: ProjectMetadataContextPort;
}

export function createProjectMetadataContextSourceProvider(
  options: ProjectMetadataContextSourceProviderOptions,
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.projectMetadata,
    async collect(input: ContextSourceInput) {
      const projection = await options.port.load({
        identity: input.identity,
        signal: input.signal,
      });
      const text = stableJson(projection.metadata);
      assertBoundedText(text, MAX_METADATA_BYTES, "Project metadata");
      const item = createCodingTextItem({
        id: `coding.project-metadata:${projection.sourceRef}`,
        providerId: CODING_CONTEXT_SOURCE_IDS.projectMetadata,
        sourceRef: projection.sourceRef,
        version: projection.version,
        type: "coding.project_metadata",
        scope: "PROJECT",
        retention: "RETRIEVABLE",
        priorityClass: "LOW",
        cacheStability: "SEMI_STABLE",
        freshness: "CURRENT",
        sensitivity: "INTERNAL",
        whyLoaded: "safe project metadata reference",
        text,
        input,
        tokenEstimator,
      });
      return createCodingSourceResult(CODING_CONTEXT_SOURCE_IDS.projectMetadata, PROVIDER_VERSION, [
        item,
      ]);
    },
  });
}
