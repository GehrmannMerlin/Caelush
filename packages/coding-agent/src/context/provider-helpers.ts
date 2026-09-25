import {
  createContextItemId,
  createContextSourceItem,
  createUtf8HeuristicTokenEstimator,
  freezeContextSourceResult,
  type ContextItem,
  type ContextSourceId,
  type ContextSourceResult,
  type ContextSourceInput,
  type ContextTokenEstimatorPort,
} from "@caelush/agent";

export interface CodingContextProviderOptions {
  readonly tokenEstimator?: ContextTokenEstimatorPort;
}

export function resolveCodingTokenEstimator(
  options: CodingContextProviderOptions,
): ContextTokenEstimatorPort {
  return options.tokenEstimator ?? createUtf8HeuristicTokenEstimator();
}

export function createCodingSourceResult(
  providerId: ContextSourceId,
  providerVersion: string,
  items: readonly ContextItem[],
): ContextSourceResult {
  return freezeContextSourceResult({
    providerId,
    providerVersion,
    items,
    diagnostics: [],
  });
}

export function createCodingTextItem(input: {
  readonly id: string;
  readonly providerId: ContextSourceId;
  readonly sourceRef: string;
  readonly version: string;
  readonly type: string;
  readonly scope: ContextItem["scope"];
  readonly retention: ContextItem["retention"];
  readonly priorityClass: ContextItem["priorityClass"];
  readonly cacheStability: ContextItem["cacheStability"];
  readonly freshness: ContextItem["freshness"];
  readonly sensitivity: ContextItem["sensitivity"];
  readonly whyLoaded: string;
  readonly text: string;
  readonly input: ContextSourceInput;
  readonly tokenEstimator: ContextTokenEstimatorPort;
}): ContextItem {
  return createContextSourceItem({
    id: createContextItemId(input.id),
    type: input.type,
    source: {
      providerId: input.providerId,
      sourceRef: input.sourceRef,
      version: input.version,
    },
    scope: input.scope,
    retention: input.retention,
    priorityClass: input.priorityClass,
    tokenEstimate: input.tokenEstimator.estimateText(input.text, input.input.model),
    cacheStability: input.cacheStability,
    freshness: input.freshness,
    sensitivity: input.sensitivity,
    whyLoaded: input.whyLoaded,
    payload: { kind: "TEXT", text: input.text },
  });
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertBoundedText(value: string, maxBytes: number, label: string): void {
  if (value.length === 0 || value.includes("\0") || utf8ByteLength(value) > maxBytes) {
    throw new TypeError(`${label} exceeds its bounded text contract.`);
  }
}
