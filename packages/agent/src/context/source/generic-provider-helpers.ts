import {
  createContextItemId,
  type ContextItem,
  type ContextSourceId,
} from "../item/context-item.js";
import { createContextSourceItem, freezeContextSourceResult } from "./context-source-item.js";
import type { ContextSourceResult } from "./context-source.js";

export function createSourceResult(
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

export function createSourceTextItem(input: {
  readonly id: string;
  readonly providerId: ContextSourceId;
  readonly sourceRef: string;
  readonly version: string;
  readonly type: string;
  readonly scope: ContextItem["scope"];
  readonly retention: ContextItem["retention"];
  readonly priorityClass: ContextItem["priorityClass"];
  readonly tokenEstimate: number;
  readonly cacheStability: ContextItem["cacheStability"];
  readonly freshness: ContextItem["freshness"];
  readonly sensitivity: ContextItem["sensitivity"];
  readonly whyLoaded: string;
  readonly text: string;
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
    tokenEstimate: input.tokenEstimate,
    cacheStability: input.cacheStability,
    freshness: input.freshness,
    sensitivity: input.sensitivity,
    whyLoaded: input.whyLoaded,
    payload: { kind: "TEXT", text: input.text },
  });
}

export function estimateContextTokens(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const byteLength = new TextEncoder().encode(serialized ?? "").byteLength;
  return Math.max(1, Math.ceil(byteLength / 4));
}

export function mapLegacyPriority(
  priorityClass: "CRITICAL" | "HIGH" | "NORMAL" | "OPTIONAL",
): ContextItem["priorityClass"] {
  return priorityClass === "OPTIONAL" ? "LOW" : priorityClass;
}
