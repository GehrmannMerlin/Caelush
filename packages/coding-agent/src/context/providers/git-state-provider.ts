import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";

import type { GitStateContextPort } from "../ports.js";
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

const PROVIDER_VERSION = "git-state-v1";
const MAX_CHANGED_PATHS = 128;
const MAX_PATH_BYTES = 4096;
const MAX_SUMMARY_BYTES = 8 * 1024;

export interface GitStateContextSourceProviderOptions extends CodingContextProviderOptions {
  readonly port: GitStateContextPort;
}

export function createGitStateContextSourceProvider(
  options: GitStateContextSourceProviderOptions,
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.gitState,
    async collect(input: ContextSourceInput) {
      const projection = await options.port.read({
        identity: input.identity,
        signal: input.signal,
      });
      assertSafeOpaqueReference(projection.sourceRef, "Git sourceRef");
      if (projection.changedPaths.length > MAX_CHANGED_PATHS) {
        throw new TypeError("Git changed paths exceed their bounded count.");
      }
      for (const path of projection.changedPaths) {
        assertBoundedText(path, MAX_PATH_BYTES, "Git changed path");
        if (path.startsWith("/") || path.startsWith("\\") || path.includes("..")) {
          throw new TypeError("Git changed path must remain workspace-relative.");
        }
      }
      if (projection.branch !== undefined) {
        assertBoundedText(projection.branch, MAX_PATH_BYTES, "Git branch");
      }
      assertBoundedText(projection.summary, MAX_SUMMARY_BYTES, "Git summary");
      const item = createCodingTextItem({
        id: `coding.git-state:${projection.sourceRef}`,
        providerId: CODING_CONTEXT_SOURCE_IDS.gitState,
        sourceRef: projection.sourceRef,
        version: projection.version,
        type: "coding.git_state",
        scope: "PROJECT",
        retention: "RETRIEVABLE",
        priorityClass: "LOW",
        cacheStability: "SEMI_STABLE",
        freshness: "CURRENT",
        sensitivity: "INTERNAL",
        whyLoaded: "bounded Git state reference",
        text: stableJson({
          branch: projection.branch ?? null,
          changedPaths: projection.changedPaths,
          summary: projection.summary,
        }),
        input,
        tokenEstimator,
      });
      return createCodingSourceResult(CODING_CONTEXT_SOURCE_IDS.gitState, PROVIDER_VERSION, [item]);
    },
  });
}
