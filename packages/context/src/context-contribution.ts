import { redactText } from "@caelush/security/redaction";
import { createContextItem, type ContextItem, type ContextPriorityClass } from "./context-item.js";
import { truncateUtf8Bytes } from "./context-text.js";
import { Utf8HeuristicTokenEstimator } from "./token-estimator.js";

/** The Agent-side text-only shape accepted at the Context package boundary. */
export interface ContextContributionItemInput {
  readonly id: string;
  readonly priorityClass: "CRITICAL" | "HIGH" | "NORMAL" | "OPTIONAL";
  readonly content: string;
  readonly tokenEstimate?: number;
  readonly whyLoaded?: string;
}

export interface ContextContributionProjectionInput {
  readonly id: string;
  readonly source: string;
  readonly replay: "SNAPSHOT" | "RECOMPUTE";
  readonly items: readonly ContextContributionItemInput[];
}

export interface ContextContributionProjectionOptions {
  readonly runId: string;
  readonly sequence: number;
  readonly maxItemBytes?: number;
  readonly maxSourceBytes?: number;
}

const DEFAULT_MAX_ITEM_BYTES = 16 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 512;
const DEFAULT_WHY_LOADED_BYTES = 2 * 1024;
const HOST_PATH =
  /(?:[A-Za-z]:[\\/]{1,2}|\\\\[^\s\\/]+[\\/]|\/(?:Users|home|root|var|etc|opt|tmp)\/)/;

/**
 * Convert Agent's deliberately generic item into the Context package's provenance-rich item.
 * Security redaction happens before token measurement; the Hook's token hint is never authoritative.
 */
export function projectContextContributions(
  contributions: readonly ContextContributionProjectionInput[],
  options: ContextContributionProjectionOptions,
): readonly ContextItem[] {
  if (!Number.isSafeInteger(options.sequence) || options.sequence < 1) {
    throw new RangeError("Context contribution sequence must be a positive safe integer.");
  }
  const maxItemBytes = options.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES;
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const estimator = new Utf8HeuristicTokenEstimator();
  const output: ContextItem[] = [];
  for (const contribution of contributions) {
    const source = truncateUtf8Bytes(
      safeContributionText(contribution.source),
      maxSourceBytes,
    ).text;
    const contributionId = truncateUtf8Bytes(
      safeContributionText(contribution.id),
      maxSourceBytes,
    ).text;
    for (const item of contribution.items) {
      const content = truncateUtf8Bytes(safeContributionText(item.content), maxItemBytes).text;
      const itemId = truncateUtf8Bytes(safeContributionText(item.id), maxSourceBytes).text;
      const whyLoaded = truncateUtf8Bytes(
        safeContributionText(item.whyLoaded ?? `Context contribution from ${source}`),
        DEFAULT_WHY_LOADED_BYTES,
      ).text;
      const sourceRef = `context-contribution:${options.runId}:${source}:${contributionId}:${itemId}`;
      output.push(
        createContextItem({
          id: sourceRef,
          type: "CONTRIBUTION",
          sourceRef,
          scope: "RUN",
          retention: contribution.replay === "SNAPSHOT" ? "REHYDRATABLE" : "EPHEMERAL",
          priorityClass: toContextPriority(item.priorityClass),
          tokenEstimate: estimator.estimateText(content),
          cacheStability: contribution.replay === "SNAPSHOT" ? "STABLE" : "DYNAMIC",
          freshness: "CURRENT",
          sensitivity: "INTERNAL",
          whyLoaded,
          createdSequence: options.sequence,
          updatedSequence: options.sequence,
          content,
        }),
      );
    }
  }
  return Object.freeze(output);
}

function safeContributionText(value: string): string {
  const redacted = redactText(value);
  return HOST_PATH.test(redacted) ? "[REDACTED:HOST_PATH]" : redacted;
}

function toContextPriority(
  priority: ContextContributionItemInput["priorityClass"],
): ContextPriorityClass {
  return priority === "OPTIONAL" ? "LOW" : priority;
}
