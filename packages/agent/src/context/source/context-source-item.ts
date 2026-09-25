import { createContextItem, type ContextItem } from "../item/context-item.js";
import {
  assertContextSourceResult,
  type ContextSourceDiagnostic,
  type ContextSourceResult,
} from "./context-source.js";

export function createContextSourceItem(input: ContextItem): ContextItem {
  return createContextItem(input);
}

export function freezeContextSourceResult(result: ContextSourceResult): ContextSourceResult {
  assertContextSourceResult(result, result.providerId);
  const items = Object.freeze(result.items.map(createContextItem));
  const diagnostics = Object.freeze(
    result.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })),
  );
  const frozen = Object.freeze({
    providerId: result.providerId,
    providerVersion: result.providerVersion,
    items,
    diagnostics,
  });
  assertContextSourceResult(frozen, frozen.providerId);
  return frozen;
}

export type { ContextSourceDiagnostic };
