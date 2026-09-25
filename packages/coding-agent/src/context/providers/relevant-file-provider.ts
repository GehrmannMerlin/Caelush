import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";

import type { RelevantFileContextPort } from "../ports.js";
import {
  assertBoundedText,
  assertSafeOpaqueReference,
  createCodingSourceResult,
  createCodingTextItem,
  resolveCodingTokenEstimator,
  type CodingContextProviderOptions,
  utf8ByteLength,
} from "../provider-helpers.js";
import { CODING_CONTEXT_SOURCE_IDS } from "../source-ids.js";

const PROVIDER_VERSION = "relevant-files-v1";
export const CODING_RELEVANT_FILE_LIMITS = Object.freeze({
  maxSelectedFiles: 12,
  maxTotalTokens: 12_000,
  maxPerFileTokens: 4_000,
  minUsefulFileTokens: 128,
  maxReadBytes: 262_144,
});

export interface RelevantFileContextSourceProviderOptions extends CodingContextProviderOptions {
  readonly port: RelevantFileContextPort;
}

export function createRelevantFileContextSourceProvider(
  options: RelevantFileContextSourceProviderOptions,
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.relevantFiles,
    async collect(input: ContextSourceInput) {
      const projection = await options.port.load({
        identity: input.identity,
        signal: input.signal,
      });
      if (projection.sections.length > CODING_RELEVANT_FILE_LIMITS.maxSelectedFiles) {
        throw new TypeError("Relevant files exceed the 12 file limit.");
      }
      const totalTokens = projection.sections.reduce(
        (total, section) => total + section.tokenEstimate,
        0,
      );
      if (totalTokens > CODING_RELEVANT_FILE_LIMITS.maxTotalTokens) {
        throw new TypeError("Relevant files exceed the 12,000 token limit.");
      }
      const items = projection.sections.map((section) => {
        assertRelativePath(section.relativePath);
        assertSafeOpaqueReference(section.sourceRef, "Relevant file sourceRef");
        if (
          !Number.isSafeInteger(section.tokenEstimate) ||
          section.tokenEstimate < CODING_RELEVANT_FILE_LIMITS.minUsefulFileTokens ||
          section.tokenEstimate > CODING_RELEVANT_FILE_LIMITS.maxPerFileTokens
        ) {
          throw new TypeError("Relevant file section violates its token limits.");
        }
        if (
          !Number.isSafeInteger(section.bytesIncluded) ||
          section.bytesIncluded < 0 ||
          section.bytesIncluded > CODING_RELEVANT_FILE_LIMITS.maxReadBytes ||
          utf8ByteLength(section.content) > section.bytesIncluded
        ) {
          throw new TypeError("Relevant file section violates its read-byte limit.");
        }
        if (section.maxReadBytes !== undefined && section.maxReadBytes > 262_144) {
          throw new TypeError("Relevant file source metadata exceeds MAX_READ_BYTES.");
        }
        assertBoundedText(
          section.content,
          CODING_RELEVANT_FILE_LIMITS.maxReadBytes,
          "Relevant file",
        );
        return createCodingTextItem({
          id: `coding.relevant-files:${section.relativePath}`,
          providerId: CODING_CONTEXT_SOURCE_IDS.relevantFiles,
          sourceRef: section.sourceRef,
          version: section.version,
          type: "coding.relevant_file",
          scope: "PROJECT",
          retention: "RETRIEVABLE",
          priorityClass: "NORMAL",
          cacheStability: "SEMI_STABLE",
          freshness: "CURRENT",
          sensitivity: "INTERNAL",
          whyLoaded: `bounded relevant file: ${section.relativePath}`,
          text: section.content,
          input,
          tokenEstimator,
        });
      });
      return createCodingSourceResult(
        CODING_CONTEXT_SOURCE_IDS.relevantFiles,
        PROVIDER_VERSION,
        items,
      );
    },
  });
}

function assertRelativePath(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.replaceAll("\\", "/").split("/").includes("..")
  ) {
    throw new TypeError("Relevant file path must be relative to the workspace.");
  }
}
