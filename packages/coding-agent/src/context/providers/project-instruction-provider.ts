import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";

import type { ProjectInstructionContextPort } from "../ports.js";
import {
  assertBoundedText,
  createCodingSourceResult,
  createCodingTextItem,
  resolveCodingTokenEstimator,
  type CodingContextProviderOptions,
  utf8ByteLength,
} from "../provider-helpers.js";
import { CODING_CONTEXT_SOURCE_IDS } from "../source-ids.js";

const PROVIDER_VERSION = "project-instructions-v1";
const MAX_TOTAL_INSTRUCTION_BYTES = 32 * 1024;
const MAX_PATH_BYTES = 4096;

export interface ProjectInstructionContextSourceProviderOptions
  extends CodingContextProviderOptions {
  readonly port: ProjectInstructionContextPort;
}

export function createProjectInstructionContextSourceProvider(
  options: ProjectInstructionContextSourceProviderOptions,
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.projectInstructions,
    async collect(input: ContextSourceInput) {
      const projection = await options.port.load({
        identity: input.identity,
        signal: input.signal,
      });
      let totalBytes = 0;
      const items = projection.entries.map((entry) => {
        assertRelativeWorkspacePath(entry.relativePath);
        assertBoundedText(entry.content, MAX_TOTAL_INSTRUCTION_BYTES, "Project instruction");
        totalBytes += utf8ByteLength(entry.content);
        if (totalBytes > MAX_TOTAL_INSTRUCTION_BYTES) {
          throw new TypeError("Project instructions exceed the 32 KiB read cap.");
        }
        return createCodingTextItem({
          id: `coding.project-instructions:${entry.relativePath}:${entry.kind}`,
          providerId: CODING_CONTEXT_SOURCE_IDS.projectInstructions,
          sourceRef: `${projection.sourceRef}/${entry.relativePath}`,
          version: projection.version,
          type: "coding.project_instruction",
          scope: "PROJECT",
          retention: "PINNED",
          priorityClass: "HIGH",
          cacheStability: "SEMI_STABLE",
          freshness: "CURRENT",
          sensitivity: "INTERNAL",
          whyLoaded: `project instruction: ${entry.relativePath}`,
          text: entry.content,
          input,
          tokenEstimator,
        });
      });
      return createCodingSourceResult(
        CODING_CONTEXT_SOURCE_IDS.projectInstructions,
        PROVIDER_VERSION,
        items,
      );
    },
  });
}

function assertRelativeWorkspacePath(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    utf8ByteLength(value) > MAX_PATH_BYTES ||
    value.replaceAll("\\", "/").split("/").includes("..")
  ) {
    throw new TypeError("Project instruction must use a relative workspace path.");
  }
}
