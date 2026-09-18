import { ToolRegistrationError } from "./errors.js";
import {
  DEFAULT_TOOL_REGISTRY_OPTIONS as CANONICAL_DEFAULT_TOOL_REGISTRY_OPTIONS,
  type ToolRegistryOptions as CanonicalToolRegistryOptions,
} from "@caelush/agent";

/**
 * Legacy registry options.
 *
 * ```text
 * maxTools              64
 * maxDescriptionBytes   8192
 * maxInputSchemaBytes   5000
 * maxOutputSchemaBytes  16384     the result-details schema budget, under its legacy name
 * maxCatalogBytes       262144
 * ```
 *
 * Every default is the value the Tool System already enforced, unchanged. The only difference from
 * the canonical option set is the *name* of the result-schema budget: the canonical contract calls it
 * `maxResultSchemaBytes` because the contract it bounds is `resultDetailsSchema`, while this legacy
 * option keeps `maxOutputSchemaBytes` so an existing caller's object literal and every existing
 * assertion about the shape keep working.
 *
 * The two names are two facets of one budget, and a registration may state either. When both are
 * present the canonical name wins, so a caller that is mid-migration is never silently bounded by a
 * value it thought it had replaced.
 */
export type ToolRegistryOptions = Omit<CanonicalToolRegistryOptions, "maxResultSchemaBytes"> & {
  readonly maxOutputSchemaBytes?: number | undefined;
};

export const DEFAULT_TOOL_REGISTRY_OPTIONS: ToolRegistryOptions = Object.freeze({
  maxTools: CANONICAL_DEFAULT_TOOL_REGISTRY_OPTIONS.maxTools,
  maxDescriptionBytes: CANONICAL_DEFAULT_TOOL_REGISTRY_OPTIONS.maxDescriptionBytes,
  maxInputSchemaBytes: CANONICAL_DEFAULT_TOOL_REGISTRY_OPTIONS.maxInputSchemaBytes,
  maxCatalogBytes: CANONICAL_DEFAULT_TOOL_REGISTRY_OPTIONS.maxCatalogBytes,
  maxOutputSchemaBytes: CANONICAL_DEFAULT_TOOL_REGISTRY_OPTIONS.maxResultSchemaBytes,
});

/**
 * Project legacy options onto the canonical option set.
 *
 * A positive integer is required for every budget; an invalid value is refused, never quietly
 * clamped to a default. The result-schema budget is the canonical `maxResultSchemaBytes` field, so a
 * legacy caller states the value once, under either name.
 */
export function toCanonicalToolRegistryOptions(
  options: ToolRegistryOptions,
): CanonicalToolRegistryOptions {
  const canonical: CanonicalToolRegistryOptions = {
    maxTools: options.maxTools,
    maxDescriptionBytes: options.maxDescriptionBytes,
    maxInputSchemaBytes: options.maxInputSchemaBytes,
    maxResultSchemaBytes: options.maxOutputSchemaBytes ?? Number.NaN,
    maxCatalogBytes: options.maxCatalogBytes,
  };
  for (const [name, value] of Object.entries(canonical)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ToolRegistrationError(`Tool registry option ${name} must be a positive integer.`, {
        reason: "INVALID_REGISTRY_OPTION",
      });
    }
  }
  return canonical;
}

/** The legacy validation entry point. It validates the same budgets the canonical set declares. */
export function validateToolRegistryOptions(options: ToolRegistryOptions): ToolRegistryOptions {
  toCanonicalToolRegistryOptions(options);
  return options;
}
